import type { CraftLine } from './types'

export type OwnedQuantities = Record<number, number>

export function clampOwned(quantity: number, maximum: number): number {
  return Math.max(0, Math.min(Math.floor(Number(quantity) || 0), Math.max(0, Math.floor(maximum))))
}

export function setOwned(owned: OwnedQuantities, itemId: number, quantity: number, maximum: number): OwnedQuantities {
  const next = { ...owned }
  const safe = clampOwned(quantity, maximum)
  if (safe) next[itemId] = safe
  else delete next[itemId]
  return next
}

export function toggleOwned(owned: OwnedQuantities, itemId: number, maximum: number): OwnedQuantities {
  return setOwned(owned, itemId, (owned[itemId] || 0) >= maximum ? 0 : maximum, maximum)
}

export function allocateOwned(lines: CraftLine[], owned: OwnedQuantities): Record<string, number> {
  const consumed = new Map<number, number>()
  return Object.fromEntries(lines.map((line) => {
    const alreadyAllocated = consumed.get(line.itemId) || 0
    const allocation = Math.min(Math.max((owned[line.itemId] || 0) - alreadyAllocated, 0), line.quantity)
    consumed.set(line.itemId, alreadyAllocated + allocation)
    return [line.lineKey, allocation]
  }))
}

export function setCraftLineComplete(
  owned: OwnedQuantities,
  lines: CraftLine[],
  lineKey: string,
  complete: boolean,
): OwnedQuantities {
  const line = lines.find((candidate) => candidate.lineKey === lineKey)
  if (!line) return owned
  const sameItemLines = lines.filter((candidate) => candidate.itemId === line.itemId)
  const lineIndex = sameItemLines.findIndex((candidate) => candidate.lineKey === lineKey)
  const prefixMaximum = sameItemLines.slice(0, lineIndex + 1).reduce((total, candidate) => total + candidate.quantity, 0)
  const beforeMaximum = prefixMaximum - line.quantity
  const totalMaximum = sameItemLines.reduce((total, candidate) => total + candidate.quantity, 0)
  return setOwned(owned, line.itemId, complete ? Math.max(owned[line.itemId] || 0, prefixMaximum) : Math.min(owned[line.itemId] || 0, beforeMaximum), totalMaximum)
}

export function setCraftLineAllocation(
  owned: OwnedQuantities,
  lines: CraftLine[],
  lineKey: string,
  allocation: number,
): OwnedQuantities {
  const line = lines.find((candidate) => candidate.lineKey === lineKey)
  if (!line) return owned
  const sameItemLines = lines.filter((candidate) => candidate.itemId === line.itemId)
  const lineIndex = sameItemLines.findIndex((candidate) => candidate.lineKey === lineKey)
  const beforeMaximum = sameItemLines.slice(0, lineIndex).reduce((total, candidate) => total + candidate.quantity, 0)
  const totalMaximum = sameItemLines.reduce((total, candidate) => total + candidate.quantity, 0)
  const currentAllocation = allocateOwned(lines, owned)[lineKey] || 0
  const desiredAllocation = clampOwned(allocation, line.quantity)
  const adjustedTotal = (owned[line.itemId] || 0) + desiredAllocation - currentAllocation
  const nextTotal = desiredAllocation > currentAllocation
    ? Math.max(adjustedTotal, beforeMaximum + desiredAllocation)
    : Math.min(adjustedTotal, beforeMaximum + desiredAllocation)
  return setOwned(owned, line.itemId, nextTotal, totalMaximum)
}
