import { memo } from "react";
import type { AssistantActivityItem } from "../../../lib/assistant-turns";
import { isDelegationActivityItem, type DelegationActivityItem, type SubagentOutcome, type SubagentTiming } from "../../../lib/subagent-topology";
import { reviewChangeFromMessage } from "../../../lib/workspace-review";
import { ReviewChangeCard } from "../../../components/ReviewChangeCard";
import { ThinkingRow } from "./shared";
import { HostedSearchRow } from "./HostedSearchRow";
import { SubagentTopology } from "./SubagentDetail";
import { ToolRow } from "./ToolRow";
import { useRenderBlocks, type RenderBlock } from "./render-blocks";

function itemKey(item: AssistantActivityItem) {
  if (item.kind === "tool") return item.message.id;
  if (item.kind === "hostedSearch") return `hosted-search-${item.message.id}-${item.round.id}`;
  return `thinking-${item.message.id}`;
}

type ActivityItemsProps = {
  items: readonly AssistantActivityItem[];
  isActive: boolean;
  live: boolean;
  delegateItems: DelegationActivityItem[];
  delegationStatuses: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings: ReadonlyMap<string, SubagentTiming>;
  /** Detailed density: open tool details and completed reasoning rows. */
  openDetails?: boolean;
  /** Compact and detailed expand every visible Thinking row by default. */
  thinkingDefaultOpen?: boolean;
  /** One-line step rows, used inside a folded turn. */
  dense?: boolean;
  onUserInteraction: () => void;
};

type ActivityItemBlockProps = Omit<ActivityItemsProps, "items" | "delegateItems" | "delegationStatuses" | "delegationTimings"> & {
  block: RenderBlock<AssistantActivityItem>;
  topologyItem?: AssistantActivityItem;
  delegateItems?: DelegationActivityItem[];
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
};

const ActivityItemBlock = memo(function ActivityItemBlock({
  block, isActive, live, topologyItem, openDetails, thinkingDefaultOpen, dense,
  delegateItems, delegationStatuses, delegationTimings, onUserInteraction,
}: ActivityItemBlockProps) {
  return <>{block.items.map((item) => {
    // The topology predicate narrows to all tools, but a false result can still
    // be an ordinary tool. Do not exclude tools from the remaining branches.
    const delegation = Boolean(isDelegationActivityItem(item));
    if (delegation) {
      if (item !== topologyItem || !delegateItems) return null;
      return <SubagentTopology
        key="subagent-topology"
        items={delegateItems}
        delegationStatuses={delegationStatuses}
        delegationTimings={delegationTimings}
        onUserInteraction={onUserInteraction}
      />;
    }
    // A tool row starts collapsed unless the density asks for details: only the
    // user opens a payload, and `detailed` is that request made once for all. A
    // review-backed edit is already a complete tool-level row (file header +
    // diff body), so rendering the generic tool row above it would repeat the
    // file header.
    if (item.kind === "tool") {
      if (reviewChangeFromMessage(item.message)) {
        return <ReviewChangeCard
          key={item.message.id}
          message={item.message}
          asToolRow
          autoOpen={openDetails}
          onUserInteraction={onUserInteraction}
        />;
      }
      return <ToolRow
        key={item.message.id}
        imagesInTurn
        message={item.message}
        autoOpen={openDetails}
        dense={dense}
        onUserInteraction={onUserInteraction}
        {...(item.delegate ? { delegate: item.delegate } : {})}
      />;
    }
    if (item.kind === "hostedSearch") return <HostedSearchRow
      key={`hosted-search-${item.message.id}-${item.round.id}`}
      messageId={item.message.id}
      round={item.round}
      streaming={isActive && item.message.status === "streaming"}
      onUserInteraction={onUserInteraction}
    />;
    // A live burst keeps all of its reasoning rows open, not only the newest:
    // folding the previous thought the moment a tool call or answer arrives made
    // running reasoning vanish under the reader's pointer. A settled burst still
    // follows the density default, and an explicit choice always wins.
    return <ThinkingRow
      key={`thinking-${item.message.id}`}
      message={item.message}
      streaming={isActive && item.message.status === "streaming"}
      autoOpen={thinkingDefaultOpen || openDetails || live}
      onUserInteraction={onUserInteraction}
    />;
  })}</>;
});

export const ActivityItems = memo(function ActivityItems({ items, ...context }: ActivityItemsProps) {
  const blocks = useRenderBlocks(items, itemKey);
  const topologyItem = context.delegateItems[0];
  return <>{blocks.map((block) => {
    const ownsTopology = topologyItem !== undefined && block.items.includes(topologyItem);
    return <ActivityItemBlock
      key={block.key}
      block={block}
      isActive={context.isActive}
      live={context.live}
      openDetails={context.openDetails}
      thinkingDefaultOpen={context.thinkingDefaultOpen}
      dense={context.dense}
      topologyItem={ownsTopology ? topologyItem : undefined}
      delegateItems={ownsTopology ? context.delegateItems : undefined}
      delegationStatuses={ownsTopology ? context.delegationStatuses : undefined}
      delegationTimings={ownsTopology ? context.delegationTimings : undefined}
      onUserInteraction={context.onUserInteraction}
    />;
  })}</>;
});
