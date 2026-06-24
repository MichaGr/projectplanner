import { useCallback, useReducer, type SetStateAction } from 'react';
import type { PlannerSnapshot } from '../model/types';

export const plannerSnapshotReducer = (
  state: PlannerSnapshot,
  action: SetStateAction<PlannerSnapshot>,
): PlannerSnapshot => (typeof action === 'function' ? action(state) : action);

export function usePlannerSnapshot(initializer: () => PlannerSnapshot) {
  const [snapshot, dispatch] = useReducer(plannerSnapshotReducer, undefined, initializer);
  const setSnapshot = useCallback((action: SetStateAction<PlannerSnapshot>) => dispatch(action), []);
  return [snapshot, setSnapshot] as const;
}
