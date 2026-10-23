#!/usr/bin/env node
/**
 * V8 heap snapshot capture and retention summary.
 *
 * `captureHeapSnapshot` drives CDP `HeapProfiler` on a renderer target and
 * writes the streamed chunks to one `.heapsnapshot` file.
 *
 * `summarizeHeapSnapshot` reads that file and answers the question a memory
 * investigation actually asks: which objects *retain* the heap, not only which
 * ones are big themselves. It rebuilds the strong-reference graph, computes the
 * dominator tree (Cooper–Harvey–Kennedy over postorder numbers), derives each
 * node's retained size, and aggregates the result by constructor. For the
 * largest instances it also walks the retainer chain up to the root, because a
 * constructor name alone rarely says which module forgot to release something.
 *
 * Usage as a CLI (analysis only, no Electron needed):
 *   node scripts/e2e/heap-snapshot.mjs <file.heapsnapshot> [--top 20] [--paths 3]
 *     [--json <out.json>]
 */
import { readFileSync, writeFileSync } from "node:fs";

/** Edge types that do not keep a target alive. */
const NON_RETAINING_EDGE_TYPES = new Set(["weak"]);
const MAX_DOMINATOR_PASSES = 8;

/**
 * Capture a heap snapshot of the attached target into `path`.
 *
 * @param {{ send: (method: string, params?: object) => Promise<unknown>,
 *           on: (handler: (method: string, params: unknown) => void) => void }} cdp
 * @param {{ path: string, timeoutMs?: number }} options
 * @returns {Promise<{ path: string, bytes: number, chunks: number }>}
 */
export async function captureHeapSnapshot(cdp, { path, timeoutMs = 600_000 }) {
  // Chunk text arrives as events; the command settles only after the last one.
  const chunks = [];
  cdp.on((method, params) => {
    if (method === "HeapProfiler.addHeapSnapshotChunk") chunks.push(params.chunk);
  });
  await cdp.send("HeapProfiler.enable", {});
  await Promise.race([
    cdp.send("HeapProfiler.takeHeapSnapshot", {
      reportProgress: false,
      captureNumericValue: false,
    }),
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("HeapProfiler.takeHeapSnapshot timed out")), timeoutMs);
    }),
  ]);
  const text = chunks.join("");
  writeFileSync(path, text);
  await cdp.send("HeapProfiler.disable", {}).catch(() => undefined);
  return { path, bytes: Buffer.byteLength(text), chunks: chunks.length };
}

function readOffsets(meta, fields) {
  return fields.map((field) => meta.indexOf(field));
}

/**
 * Summarize a written heap snapshot file.
 *
 * @param {string} path
 * @param {{ top?: number, paths?: number, pathDepth?: number, needle?: string }} options
 */
export function summarizeHeapSnapshot(path, options = {}) {
  const top = options.top ?? 20;
  const pathDepth = options.pathDepth ?? 14;
  const pathCount = options.paths ?? 3;
  const needle = options.needle;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const snapshot = raw.snapshot;
  const meta = snapshot.meta;
  const nodeFields = meta.node_fields;
  const edgeFields = meta.edge_fields;
  const nodeTypeNames = meta.node_types[0];
  const edgeTypeNames = meta.edge_types[0];
  const nodeFieldCount = nodeFields.length;
  const edgeFieldCount = edgeFields.length;
  const [nodeTypeOffset, nodeNameOffset, nodeSelfSizeOffset, nodeEdgeCountOffset] =
    readOffsets(nodeFields, ["type", "name", "self_size", "edge_count"]);
  const [edgeTypeOffset, edgeNameOffset, edgeToNodeOffset] = readOffsets(edgeFields, [
    "type",
    "name_or_index",
    "to_node",
  ]);
  const elementEdgeTypes = new Set(
    ["element", "hidden"].map((name) => edgeTypeNames.indexOf(name)).filter((i) => i >= 0),
  );
  const strings = raw.strings;
  const nodes = raw.nodes;
  const edges = raw.edges;
  const nodeCount = snapshot.node_count;
  const edgeCount = snapshot.edge_count;
  const nonRetaining = new Set(
    [...NON_RETAINING_EDGE_TYPES].map((name) => edgeTypeNames.indexOf(name)).filter((i) => i >= 0),
  );
  // Per-node scalars, then the strong-edge adjacency in both directions.
  const selfSize = new Float64Array(nodeCount);
  const nodeType = new Uint8Array(nodeCount);
  const nodeName = new Int32Array(nodeCount);
  const edgeStart = new Uint32Array(nodeCount + 1);
  let cursor = 0;
  for (let node = 0; node < nodeCount; node += 1) {
    const base = node * nodeFieldCount;
    nodeType[node] = nodes[base + nodeTypeOffset];
    nodeName[node] = nodes[base + nodeNameOffset];
    selfSize[node] = nodes[base + nodeSelfSizeOffset];
    cursor += nodes[base + nodeEdgeCountOffset];
    edgeStart[node + 1] = cursor;
  }
  const revStart = new Uint32Array(nodeCount + 1);
  for (let index = 0; index < edgeCount; index += 1) {
    if (nonRetaining.has(edges[index * edgeFieldCount + edgeTypeOffset])) continue;
    revStart[(edges[index * edgeFieldCount + edgeToNodeOffset] / nodeFieldCount) + 1] += 1;
  }
  for (let node = 0; node < nodeCount; node += 1) revStart[node + 1] += revStart[node];
  const revTargets = new Int32Array(revStart[nodeCount]);
  // The edge a retainer points with: `name_or_index` is a string index for
  // property/context edges and an array index for element edges, and that name
  // is what still says "sessionTranscriptCache" after minification.
  const revEdgeType = new Uint8Array(revStart[nodeCount]);
  const revEdgeName = new Int32Array(revStart[nodeCount]);
  const revFill = new Int32Array(nodeCount);
  for (let node = 0; node < nodeCount; node += 1) {
    for (let index = edgeStart[node]; index < edgeStart[node + 1]; index += 1) {
      if (nonRetaining.has(edges[index * edgeFieldCount + edgeTypeOffset])) continue;
      const target = edges[index * edgeFieldCount + edgeToNodeOffset] / nodeFieldCount;
      const slot = revStart[target] + revFill[target];
      revTargets[slot] = node;
      revEdgeType[slot] = edges[index * edgeFieldCount + edgeTypeOffset];
      revEdgeName[slot] = edges[index * edgeFieldCount + edgeNameOffset];
      revFill[target] += 1;
    }
  }

  // Iterative DFS from the root: postorder numbers, then RPO dominators.
  const visited = new Uint8Array(nodeCount);
  const postNumber = new Int32Array(nodeCount).fill(-1);
  const edgeCursor = new Uint32Array(nodeCount);
  const postorder = new Int32Array(nodeCount);
  const stack = new Int32Array(nodeCount);
  let stackSize = 0;
  let postCounter = 0;
  if (nodeCount > 0) {
    visited[0] = 1;
    stack[0] = 0;
    stackSize = 1;
    edgeCursor[0] = edgeStart[0];
    while (stackSize > 0) {
      const node = stack[stackSize - 1];
      const end = edgeStart[node + 1];
      let index = edgeCursor[node];
      let descended = false;
      while (index < end) {
        const offset = index * edgeFieldCount;
        index += 1;
        if (nonRetaining.has(edges[offset + edgeTypeOffset])) continue;
        const target = edges[offset + edgeToNodeOffset] / nodeFieldCount;
        if (visited[target]) continue;
        visited[target] = 1;
        edgeCursor[node] = index;
        stack[stackSize] = target;
        stackSize += 1;
        edgeCursor[target] = edgeStart[target];
        descended = true;
        break;
      }
      if (descended) continue;
      edgeCursor[node] = index;
      postNumber[node] = postCounter;
      postorder[postCounter] = node;
      postCounter += 1;
      stackSize -= 1;
    }
  }

  const idom = new Int32Array(nodeCount).fill(-1);
  if (nodeCount > 0) idom[0] = 0;
  const intersect = (left, right) => {
    while (left !== right) {
      while (postNumber[left] < postNumber[right]) left = idom[left];
      while (postNumber[right] < postNumber[left]) right = idom[right];
    }
    return left;
  };
  let changed = true;
  for (let pass = 0; pass < MAX_DOMINATOR_PASSES && changed; pass += 1) {
    changed = false;
    for (let at = postCounter - 1; at >= 0; at -= 1) {
      const node = postorder[at];
      if (node === 0) continue;
      let candidate = -1;
      for (let index = revStart[node]; index < revStart[node + 1]; index += 1) {
        const pred = revTargets[index];
        if (idom[pred] === -1) continue;
        candidate = candidate === -1 ? pred : intersect(pred, candidate);
      }
      if (candidate !== -1 && idom[node] !== candidate) {
        idom[node] = candidate;
        changed = true;
      }
    }
  }

  // Retained size: postorder visits every subtree before its dominator.
  const retained = new Float64Array(nodeCount);
  for (let node = 0; node < nodeCount; node += 1) retained[node] = selfSize[node];
  for (let at = 0; at < postCounter; at += 1) {
    const node = postorder[at];
    if (node === 0 || idom[node] < 0) continue;
    retained[idom[node]] += retained[node];
  }

  const label = (node) => `${nodeTypeNames[nodeType[node]]}:${strings[nodeName[node]] ?? ""}`;
  const groups = new Map();
  for (let node = 0; node < nodeCount; node += 1) {
    const key = label(node);
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.selfSize += selfSize[node];
      group.retainedSize += retained[node];
      if (retained[node] > retained[group.largestNode]) group.largestNode = node;
    } else {
      groups.set(key, {
        name: key,
        count: 1,
        selfSize: selfSize[node],
        retainedSize: retained[node],
        largestNode: node,
      });
    }
  }

  const edgeLabel = (edgeTypeIndex, nameOrIndex) =>
    elementEdgeTypes.has(edgeTypeIndex) ? `[${nameOrIndex}]` : (strings[nameOrIndex] ?? "");

  const retainerPath = (node) => {
    const frames = [];
    let current = node;
    for (let depth = 0; depth < pathDepth && current !== 0; depth += 1) {
      let bestSlot = -1;
      for (let index = revStart[current]; index < revStart[current + 1]; index += 1) {
        const pred = revTargets[index];
        if (pred === current) continue;
        if (bestSlot === -1 || retained[pred] > retained[revTargets[bestSlot]]) bestSlot = index;
      }
      if (bestSlot === -1) break;
      const best = revTargets[bestSlot];
      frames.push({
        node: label(best),
        via: edgeLabel(revEdgeType[bestSlot], revEdgeName[bestSlot]),
        retainedSize: retained[best],
        selfSize: selfSize[best],
      });
      current = best;
    }
    return frames;
  };


  const ranked = [...groups.values()].sort((a, b) => b.retainedSize - a.retainedSize);
  const byRetained = ranked.slice(0, top).map((group) => ({
    name: group.name,
    count: group.count,
    selfSize: group.selfSize,
    retainedSize: group.retainedSize,
  }));
  const bySelf = [...ranked]
    .sort((a, b) => b.selfSize - a.selfSize)
    .slice(0, top)
    .map((group) => ({
      name: group.name,
      count: group.count,
      selfSize: group.selfSize,
      retainedSize: group.retainedSize,
    }));
  const deepest = ranked
    .filter((group) => group.largestNode !== 0)
    .slice(0, pathCount)
    .map((group) => ({
      name: group.name,
      retainedSize: group.retainedSize,
      sampleSelfSize: selfSize[group.largestNode],
      retainers: retainerPath(group.largestNode),
    }));

  // Large single objects say more than aggregated constructors: a 500 KB string
  // is one payload whose retainer chain names the cache that still holds it.
  const candidates = [];
  const stringGroups = new Map();
  for (let node = 1; node < nodeCount; node += 1) {
    const type = nodeTypeNames[nodeType[node]];
    if (type === "synthetic" || type === "code") continue;
    if (selfSize[node] <= 0) continue;
    if (type === "string" || type === "concatenated string") {
      // Group by leading text: a cache that keeps 180 copies of the same tool
      // result is invisible in a constructor summary and obvious here.
      const text = strings[nodeName[node]] ?? "";
      const key = `${type}: ${text.slice(0, 48)}`;
      const group = stringGroups.get(key);
      if (group) {
        group.count += 1;
        group.size += selfSize[node];
      } else {
        stringGroups.set(key, { name: key, count: 1, size: selfSize[node] });
      }
    }
    // `ExternalStringData` is the backing store of the script-source string that
    // is reported separately; counting both would double the same bytes.
    if (label(node) === "native:system / ExternalStringData") continue;
    candidates.push(node);
  }
  candidates.sort((left, right) => selfSize[right] - selfSize[left]);
  const largestNodes = candidates.slice(0, pathCount * 3).map((node) => ({
    name: label(node),
    selfSize: selfSize[node],
    retainedSize: retained[node],
    retainers: retainerPath(node),
  }));
  const largestStrings = [...stringGroups.values()]
    .sort((left, right) => right.size - left.size)
    .slice(0, 12);

  // Chains for one payload family: the answer to "which structure still holds
  // these bytes", grouped by the first frames of the retainer path.
  const needleChains = (() => {
    if (!needle) return undefined;
    const matches = new Map();
    let matched = 0;
    for (let node = 1; node < nodeCount; node += 1) {
      const type = nodeTypeNames[nodeType[node]];
      if (type !== "string" && type !== "concatenated string") continue;
      const text = strings[nodeName[node]];
      if (typeof text !== "string" || !text.includes(needle)) continue;
      matched += 1;
      const chain = retainerPath(node);
      const key = chain
        .slice(0, 6)
        .map((frame) => `${frame.node} ⟨${frame.via}⟩`.replace(/@\d+/g, "@…").replace(/\[\d+\]/g, "[]").slice(0, 70))
        .join(" <- ");
      const group = matches.get(key);
      if (group) {
        group.count += 1;
        group.bytes += selfSize[node];
      } else {
        matches.set(key, { key, count: 1, bytes: selfSize[node] });
      }
    }
    return {
      needle,
      matched,
      groups: [...matches.values()].sort((left, right) => right.bytes - left.bytes).slice(0, 8),
    };
  })();
  return {
    largestStrings,
    needleChains,
    path,
    nodeCount,
    edgeCount,
    reachableNodeCount: postCounter,
    totalHeapSize: nodeCount > 0 ? retained[0] : 0,
    totalSelfSize: selfSize.reduce((sum, value) => sum + value, 0),
    groups: groups.size,
    topByRetainedSize: byRetained,
    topBySelfSize: bySelf,
    largestInstances: deepest,
    largestNodes,
    edgeTypeNames,
  };
}

function parseArgs(argv) {
  const out = { file: undefined, top: 20, paths: 3, json: undefined, text: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--top" && argv[index + 1]) out.top = Number(argv[(index += 1)]);
    else if (arg === "--paths" && argv[index + 1]) out.paths = Number(argv[(index += 1)]);
    else if (arg === "--json" && argv[index + 1]) out.json = argv[(index += 1)];
    else if (arg === "--text" && argv[index + 1]) out.text = argv[(index += 1)];
    else if (!arg.startsWith("--")) out.file = arg;
  }
  return out;
}

function formatBytes(value) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error("usage: node scripts/e2e/heap-snapshot.mjs <file.heapsnapshot> [--top N] [--paths N] [--json out.json]");
    process.exit(2);
  }
  const summary = summarizeHeapSnapshot(args.file, {
    top: args.top,
    paths: args.paths,
    needle: args.text,
  });
  if (args.json) writeFileSync(args.json, JSON.stringify(summary, null, 2));
  console.log(
    `nodes=${summary.nodeCount} edges=${summary.edgeCount} retained(root)=${formatBytes(summary.totalHeapSize)} groups=${summary.groups}`,
  );
  console.log("\ntop by retained size:");
  for (const group of summary.topByRetainedSize) {
    console.log(
      `  ${formatBytes(group.retainedSize).padStart(9)}  ${String(group.count).padStart(8)}x  ${group.name}`,
    );
  }
  console.log("\nmost-duplicated strings:");
  for (const group of summary.largestStrings) {
    console.log(`  ${formatBytes(group.size).padStart(9)} ${String(group.count).padStart(6)}x ${group.name.replace(/\s+/g, " ").slice(0, 100)}`);
  }
  if (summary.needleChains) {
    console.log(
      `\nretainer chains for strings containing "${summary.needleChains.needle}" (${summary.needleChains.matched} matched):`,
    );
    for (const group of summary.needleChains.groups) {
      console.log(`  ${formatBytes(group.bytes).padStart(9)} ${String(group.count).padStart(5)}x ${group.key}`);
    }
  }
  console.log("\nlargest single objects:");
  for (const instance of summary.largestNodes) {
    console.log(`\n${instance.name} self=${formatBytes(instance.selfSize)} retained=${formatBytes(instance.retainedSize)}`);
    for (const frame of instance.retainers) {
      console.log(`  <- ${frame.node} ⟨${frame.via}⟩ self=${formatBytes(frame.selfSize)} retained=${formatBytes(frame.retainedSize)}`);
    }
  }

}