export type TabDropPosition = "before" | "after";

export function areTabOrdersEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function appendMissingTabIds(currentOrder: string[], availableIds: string[]) {
  const availableIdSet = new Set(availableIds);
  const retainedIds = currentOrder.filter((id) => availableIdSet.has(id));
  const retainedIdSet = new Set(retainedIds);
  return [...retainedIds, ...availableIds.filter((id) => !retainedIdSet.has(id))];
}

export function moveTabId(
  currentOrder: string[],
  sourceTabId: string,
  targetTabId: string,
  position: TabDropPosition,
) {
  if (sourceTabId === targetTabId) {
    return currentOrder;
  }

  const sourceIndex = currentOrder.indexOf(sourceTabId);
  const targetIndex = currentOrder.indexOf(targetTabId);
  if (sourceIndex < 0 || targetIndex < 0) {
    return currentOrder;
  }

  const nextOrder = [...currentOrder];
  const [movedTabId] = nextOrder.splice(sourceIndex, 1);
  const nextTargetIndex = nextOrder.indexOf(targetTabId);
  nextOrder.splice(nextTargetIndex + (position === "after" ? 1 : 0), 0, movedTabId);
  return nextOrder;
}
