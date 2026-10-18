import type { NestedRepoDiscovery } from '@/stores/useGitStore';

/** Two paths spelled for different platforms still name one directory. */
export const samePath = (left: string, right: string) =>
  left.replace(/\\/g, '/').replace(/\/+$/, '') === right.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * The repositories the picker offers: the project folder first when it is
 * itself a checkout, then every repository found under it.
 */
export function queueRepositoryOptions(
  directory: string,
  rootIsGitRepo: boolean | null,
  nested: NestedRepoDiscovery | undefined,
): string[] {
  if (!directory) return [];
  const found = rootIsGitRepo === true ? [directory] : [];
  if (Array.isArray(nested)) found.push(...nested.filter(path => !samePath(path, directory)));
  return found;
}

/**
 * What the row says under its label, or `null` when it has nothing to report.
 * `missing` wins: a stored repository that discovery no longer finds is the
 * state the user has to fix, and it must not read as a clean scan. A scan that
 * failed and a runtime without the discovery route are both "could not look",
 * never "nothing there".
 */
export function queueRepositoryNote(
  repository: string | null,
  options: readonly string[],
  nested: NestedRepoDiscovery | undefined,
): 'missing' | 'scanning' | 'scanFailed' | 'none' | null {
  if (repository && !options.some(path => samePath(path, repository))) return 'missing';
  if (nested === undefined) return 'scanning';
  if (nested === null || nested === 'unsupported') return 'scanFailed';
  return options.length === 0 ? 'none' : null;
}
