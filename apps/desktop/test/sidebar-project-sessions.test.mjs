import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VISIBLE_PROJECT_SESSION_COUNT,
  projectSessionPage,
  resetProjectSessionPage,
  showMoreProjectSessions,
} from "../src/lib/sidebar-project-sessions.ts";

const rows = (count) => Array.from({ length: count }, (_, index) => `session-${index + 1}`);
const pageOf = (count, pages, projectKey) =>
  projectSessionPage(rows(count), pages, projectKey);

test("one load-more click reveals one page, never the whole history", () => {
  const projectKey = "/work/demo";
  const twelve = rows(12);
  let pages = {};

  const initial = pageOf(12, pages, projectKey);
  assert.deepEqual(initial.visibleSessions, twelve.slice(0, 5));
  assert.equal(initial.hiddenCount, 7);
  assert.equal(initial.loadMoreCount, DEFAULT_VISIBLE_PROJECT_SESSION_COUNT);
  assert.equal(initial.collapseAvailable, false);

  pages = showMoreProjectSessions(pages, projectKey, twelve.length);
  const second = pageOf(12, pages, projectKey);
  assert.deepEqual(second.visibleSessions, twelve.slice(0, 10));
  assert.equal(second.hiddenCount, 2);
  assert.equal(second.loadMoreCount, 2, "the label states the increment this click adds");
  assert.equal(
    second.collapseAvailable,
    true,
    "a partially loaded history can fold back without loading the rest",
  );

  pages = showMoreProjectSessions(pages, projectKey, twelve.length);
  const third = pageOf(12, pages, projectKey);
  assert.deepEqual(third.visibleSessions, twelve);
  assert.equal(third.hiddenCount, 0);
  assert.equal(third.loadMoreCount, 0);
  assert.equal(third.collapseAvailable, true);

  pages = resetProjectSessionPage(pages, projectKey);
  const reopened = pageOf(12, pages, projectKey);
  assert.deepEqual(reopened.visibleSessions, twelve.slice(0, 5));
  assert.equal(reopened.hiddenCount, 7);
  assert.equal(reopened.collapseAvailable, false);
});

test("group sizes around the initial page keep both controls honest", () => {
  const cases = [
    [0, { hidden: 0, loadMore: 0, collapse: false }],
    [5, { hidden: 0, loadMore: 0, collapse: false }],
    [6, { hidden: 1, loadMore: 1, collapse: false }],
  ];
  for (const [count, expected] of cases) {
    const page = pageOf(count, {}, "/work/demo");
    assert.deepEqual(
      { hidden: page.hiddenCount, loadMore: page.loadMoreCount, collapse: page.collapseAvailable },
      expected,
      `sessions=${count}`,
    );
  }
});

test("page state is per project and a fold drops only that project's page", () => {
  const pages = showMoreProjectSessions({}, "/work/demo", 12);
  const both = showMoreProjectSessions(pages, "/work/other", 12);

  assert.equal(pageOf(12, both, "/work/demo").visibleSessions.length, 10);
  assert.equal(pageOf(12, both, "/work/other").visibleSessions.length, 10);

  const folded = resetProjectSessionPage(both, "/work/demo");
  assert.equal(folded["/work/demo"], undefined);
  assert.equal(folded["/work/other"], 10);
  assert.equal(pageOf(12, folded, "/work/demo").visibleSessions.length, 5);
  assert.equal(pageOf(12, folded, "/work/other").visibleSessions.length, 10);
  assert.equal(resetProjectSessionPage(folded, "/work/missing"), folded);
});

test("a group whose sessions shrink keeps its rows and still folds back", () => {
  let pages = showMoreProjectSessions({}, "/work/demo", 12);
  pages = showMoreProjectSessions(pages, "/work/demo", 12);

  const shrunk = pageOf(6, pages, "/work/demo");
  assert.deepEqual(shrunk.visibleSessions, rows(6));
  assert.equal(shrunk.hiddenCount, 0);
  assert.equal(shrunk.collapseAvailable, true);

  const afterClick = showMoreProjectSessions(pages, "/work/demo", 6);
  assert.equal(afterClick["/work/demo"], 12, "the page size never runs past the group");
  assert.deepEqual(pageOf(6, afterClick, "/work/demo").visibleSessions, rows(6));
});

test("a stale page size below the initial page falls back to the initial page", () => {
  const page = pageOf(12, { "/work/demo": 2 }, "/work/demo");
  assert.equal(page.visibleSessions.length, DEFAULT_VISIBLE_PROJECT_SESSION_COUNT);
  assert.equal(page.collapseAvailable, false);
});
