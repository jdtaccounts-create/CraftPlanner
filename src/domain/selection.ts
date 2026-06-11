import { normalizeText } from './catalog'
import type { CatalogItem, ItemSet, SelectedItem } from './types'

export interface ParsedChoiceOption {
  label: string
  entries: SelectedItem[]
  imagePath: string
  typeName: string
}

export interface ParsedChoice {
  source: string
  quantity: number
  options: ParsedChoiceOption[]
}

export interface ParsedItemList {
  found: SelectedItem[]
  missed: string[]
  choices: ParsedChoice[]
  matchedLines: number
  matchedSets: number
}

export function addSelectedItem(selected: SelectedItem[], itemId: number, quantity = 1): SelectedItem[] {
  const safeQuantity = Math.max(1, Math.floor(Number(quantity) || 1))
  const existing = selected.find((entry) => entry.itemId === itemId)
  if (!existing) return [...selected, { itemId, quantity: safeQuantity }]
  return selected.map((entry) => entry.itemId === itemId ? { ...entry, quantity: entry.quantity + safeQuantity } : entry)
}

export function setSelectedQuantity(selected: SelectedItem[], itemId: number, quantity: number): SelectedItem[] {
  const safeQuantity = Math.max(0, Math.floor(Number(quantity) || 0))
  if (!safeQuantity) return selected.filter((entry) => entry.itemId !== itemId)
  return selected.map((entry) => entry.itemId === itemId ? { ...entry, quantity: safeQuantity } : entry)
}

export function addItemSet(selected: SelectedItem[], itemIds: number[]): SelectedItem[] {
  return itemIds.reduce((result, itemId) => addSelectedItem(result, Number(itemId), 1), selected)
}

export function splitItemLines(text: string): string[] {
  const lines: string[] = []
  let current = ''
  let parenthesisDepth = 0
  for (const character of text.replace(/\r\n?/g, '\n')) {
    if (character === '(') parenthesisDepth += 1
    if (character === ')') parenthesisDepth = Math.max(0, parenthesisDepth - 1)
    if ((character === '\n' || character === ';' || character === ',') && parenthesisDepth === 0) {
      if (current.trim()) lines.push(current.trim())
      current = ''
    } else {
      current += character
    }
  }
  if (current.trim()) lines.push(current.trim())
  return lines
}

export function parseItemLine(line: string): { name: string; quantity: number } {
  const trimmed = line.trim()
    .replace(/^[•·]\s*/, '')
    .replace(/^[-–—]\s+/, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/[.!?]+\s*$/, '')
    .trim()
  const cleanName = (name: string): string => name.replace(/\s+/g, ' ').trim()
  const prefix = trimmed.match(/^(?:x\s*)?(\d[\d\s.]*)\s*(?:x|\*|×|-)?\s+(.+)$/i)
  if (prefix) return { quantity: Number(prefix[1].replace(/[\s.]/g, '')), name: cleanName(prefix[2]) }

  const suffix = trimmed.match(/^(.+?)(?:\s*(?:x|\*|×|:)\s*|\t+|\s{2,})(\d[\d\s.]*)$/i)
  if (suffix) return { quantity: Number(suffix[2].replace(/[\s.]/g, '')), name: cleanName(suffix[1]) }

  const brackets = trimmed.match(/^\[(\d[\d\s.]*)]\s*(.+)$/)
  if (brackets) return { quantity: Number(brackets[1].replace(/[\s.]/g, '')), name: cleanName(brackets[2]) }

  return { name: cleanName(trimmed), quantity: 1 }
}

function boundedDistance(left: string, right: string, maximum: number): number {
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    let rowMinimum = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + cost,
      )
      rowMinimum = Math.min(rowMinimum, current[rightIndex])
    }
    if (rowMinimum > maximum) return maximum + 1
    previous = current
  }
  return previous[right.length]
}

function fuzzyMaximum(name: string): number {
  if (name.length < 5) return 0
  if (name.length < 9) return 1
  if (name.length < 16) return 2
  return 3
}

function distinctItems(candidates: CatalogItem[]): CatalogItem[] {
  return candidates.filter((candidate, index) =>
    candidates.findIndex((other) =>
      other.type_id === candidate.type_id
      && other.item_type_category_id === candidate.item_type_category_id
      && other.image_path === candidate.image_path) === index)
}

function preferredExactItem(candidates: CatalogItem[]): CatalogItem | null {
  const distinctCandidates = distinctItems(candidates)
  if (distinctCandidates.length === 1) return distinctCandidates[0]
  const encyclopediaCandidates = distinctCandidates.filter((candidate) => candidate.item_type_in_encyclopedia)
  return encyclopediaCandidates.length === 1 ? encyclopediaCandidates[0] : null
}

export function parseItemList(
  items: Record<string, CatalogItem>,
  itemSets: Record<string, ItemSet>,
  text: string,
): ParsedItemList {
  const byName = new Map<string, CatalogItem[]>()
  const setsByName = new Map<string, ItemSet[]>()
  const normalizedItems = Object.values(items).map((item) => ({ item, normalized: item.name_norm || normalizeText(item.name) }))
  Object.values(items).forEach((item) => {
    const key = normalizeText(item.name)
    byName.set(key, [...(byName.get(key) || []), item])
  })
  Object.values(itemSets).forEach((itemSet) => {
    const key = itemSet.name_norm || normalizeText(itemSet.name)
    setsByName.set(key, [...(setsByName.get(key) || []), itemSet])
  })

  let found: SelectedItem[] = []
  const missed: string[] = []
  const choices: ParsedChoice[] = []
  let matchedLines = 0
  let matchedSets = 0

  const resolveName = (name: string, quantity: number): ParsedChoiceOption | null => {
    const normalizedName = normalizeText(name)
    const setCandidates = setsByName.get(normalizedName) || []
    if (setCandidates.length === 1) {
      return {
        label: setCandidates[0].name,
        entries: setCandidates[0].item_ids.map((itemId) => ({ itemId, quantity })),
        imagePath: items[String(setCandidates[0].item_ids[0])]?.image_path || '',
        typeName: `${setCandidates[0].item_ids.length} items`,
      }
    }

    const exactItem = preferredExactItem(byName.get(normalizedName) || [])
    if (exactItem) {
      return {
        label: exactItem.name,
        entries: [{ itemId: exactItem.id, quantity }],
        imagePath: exactItem.image_path,
        typeName: exactItem.type_name || exactItem.raw_type,
      }
    }
    if ((byName.get(normalizedName) || []).length > 1) return null

    const maximum = fuzzyMaximum(normalizedName)
    if (!maximum) return null
    const ranked = normalizedItems
      .filter(({ normalized }) => Math.abs(normalized.length - normalizedName.length) <= maximum)
      .map(({ item, normalized }) => ({ item, distance: boundedDistance(normalizedName, normalized, maximum) }))
      .filter((candidate) => candidate.distance <= maximum)
      .sort((a, b) => a.distance - b.distance || a.item.name.localeCompare(b.item.name, 'fr'))
    if (!ranked.length || (ranked[1] && ranked[1].distance === ranked[0].distance)) return null
    return {
      label: ranked[0].item.name,
      entries: [{ itemId: ranked[0].item.id, quantity }],
      imagePath: ranked[0].item.image_path,
      typeName: ranked[0].item.type_name || ranked[0].item.raw_type,
    }
  }

  splitItemLines(text).forEach((line) => {
    const parsed = parseItemLine(line)
    const alternatives = parsed.name.split(/\s+ou\s+/i).map((name) => name.trim()).filter(Boolean)
    if (alternatives.length > 1) {
      const options = alternatives.map((name) => resolveName(name, parsed.quantity)).filter((option): option is ParsedChoiceOption => Boolean(option))
      if (options.length === alternatives.length) {
        choices.push({ source: line, quantity: parsed.quantity, options })
        matchedLines += 1
        return
      }
      missed.push(line)
      return
    }

    const resolved = resolveName(parsed.name, parsed.quantity)
    if (!resolved) {
      missed.push(line)
      return
    }
    resolved.entries.forEach((entry) => {
      found = addSelectedItem(found, entry.itemId, entry.quantity)
    })
    if (resolved.entries.length > 1) {
      matchedLines += 1
      matchedSets += 1
      return
    }
    matchedLines += 1
  })
  return { found, missed, choices, matchedLines, matchedSets }
}
