import type { CanonicalPrLifecycleState, PrInfo } from "./contracts";
import {
  classifyCanonicalPrLifecycleState,
  fetchPrInfo,
  resolvePrNumber,
  resolvePrRepository,
} from "./github";

export type MergePrContext = {
  lifecycleState: CanonicalPrLifecycleState;
  prInfo: PrInfo;
  prRepository: string;
};

export function resolveMergePrContext(options: {
  prValue: string;
  repository: string;
  repoRoot: string;
}): MergePrContext {
  const prRepository = resolvePrRepository(options.prValue, options.repository, options.repoRoot);
  const prInfo = fetchPrInfo(prRepository, resolvePrNumber(options.prValue));
  return {
    lifecycleState: classifyCanonicalPrLifecycleState(prInfo),
    prInfo,
    prRepository,
  };
}
