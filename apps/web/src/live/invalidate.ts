/**
 * Hints → refetch (API.md §7). Each query declares the topics it depends on in
 * `meta.topics`, either exact (`table:5`) or a family (`table` matches `table:5`).
 */
import type { QueryClient } from '@tanstack/react-query';

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: { topics?: readonly string[] };
  }
}

export function matchesTopics(
  queryTopics: readonly string[],
  hintTopics: readonly string[],
): boolean {
  return queryTopics.some((q) =>
    hintTopics.some((h) => h === q || (!q.includes(':') && h.startsWith(`${q}:`))),
  );
}

export function invalidateForHint(
  client: QueryClient,
  hintTopics: readonly string[],
): Promise<void> {
  return client.invalidateQueries({
    predicate: (query) => matchesTopics(query.meta?.topics ?? [], hintTopics),
  });
}

export function invalidateAll(client: QueryClient): Promise<void> {
  return client.invalidateQueries();
}
