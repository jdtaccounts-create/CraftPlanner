<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Notify } from 'quasar'
import { createCatalogSearchIndex, itemCategory, searchCatalog } from './domain/catalog'
import { buildCraftPlan, craftPlanLines } from './domain/craft'
import { allocateOwned, setCraftLineAllocation, setOwned, type OwnedQuantities } from './domain/possession'
import { addItemSet, addSelectedItem, parseItemList, setSelectedQuantity, type ParsedChoice, type ParsedChoiceOption } from './domain/selection'
import { ITEM_CATEGORIES, type CatalogData, type CraftLine, type ItemCategory, type SelectedItem } from './domain/types'
import { loadCatalogData } from './data/repository'
import { checkCatalogStatus, syncCatalogData, syncCatalogImages } from './data/sync'
import { loadPlannerState, savePlannerState } from './data/storage'

const data = shallowRef<CatalogData | null>(null)
const selected = ref<SelectedItem[]>([])
const owned = ref<OwnedQuantities>({})
const craftCheckedKeys = ref<Set<string>>(new Set())
const pendingChoices = ref<ParsedChoice[]>([])
const query = ref('')
const theme = ref<'dark' | 'light'>('dark')
const craftOpen = ref(false)
const loading = ref(true)
const status = ref('Chargement des données locales...')
const cachedImageUrls = ref<Map<number, string>>(new Map())
const appUpdate = ref<any>(null)
const showAppUpdatePrompt = ref(false)
const checkingAppUpdate = ref(false)
const installingAppUpdate = ref(false)
const appUpdateProgress = ref('')
let overflowFrame: number | undefined
let saveStateTimer: number | undefined

function persistPlannerState(): void {
  void savePlannerState({ selected: selected.value, owned: owned.value, craftCheckedKeys: [...craftCheckedKeys.value] })
}

const searchIndex = computed(() => data.value ? createCatalogSearchIndex(data.value.items, data.value.itemSets) : null)
const results = computed(() => searchIndex.value ? searchCatalog(searchIndex.value, query.value, 50) : [])
const plan = computed(() => data.value ? buildCraftPlan(data.value, selected.value) : null)
const allCraftLines = computed(() => plan.value ? craftPlanLines(plan.value) : [])
const craftAllocations = computed(() => allocateOwned(allCraftLines.value, owned.value))
const coveredByItemId = computed(() => {
  const covered = new Map<number, number>()
  if (!plan.value) return covered
  craftCheckedKeys.value.forEach((lineKey) => {
    const line = allCraftLines.value.find((candidate) => candidate.lineKey === lineKey)
    if (!line || craftOwned(line) < line.quantity) return
    Object.entries(plan.value!.dependencies[lineKey] || {}).forEach(([itemId, quantity]) => {
      covered.set(Number(itemId), (covered.get(Number(itemId)) || 0) + Number(quantity))
    })
  })
  return covered
})
const craftCoverageAllocations = computed(() => {
  const consumed = new Map<number, number>()
  return Object.fromEntries(allCraftLines.value.map((line) => {
    if (line.role === 'direct' || line.role === 'noncraftable') return [line.lineKey, 0]
    const alreadyAllocated = consumed.get(line.itemId) || 0
    const allocation = Math.min(Math.max((coveredByItemId.value.get(line.itemId) || 0) - alreadyAllocated, 0), line.quantity)
    consumed.set(line.itemId, alreadyAllocated + allocation)
    return [line.lineKey, allocation]
  }))
})

const entries = computed(() => selected.value.map((entry) => ({
  ...entry,
  item: data.value?.items[String(entry.itemId)],
})).filter((entry) => entry.item)
  .sort((a, b) => Number(entryDone(a.itemId, a.quantity)) - Number(entryDone(b.itemId, b.quantity))))

const grouped = computed(() => {
  const groups = Object.fromEntries(ITEM_CATEGORIES.map((category) => [category, [] as typeof entries.value]))
  entries.value.forEach((entry) => {
    const category = itemCategory(entry.item!)
    if (category) groups[category].push(entry)
  })
  ITEM_CATEGORIES.forEach((category) => groups[category].sort((a, b) =>
    Number(entryDone(a.itemId, a.quantity)) - Number(entryDone(b.itemId, b.quantity))
      || a.item!.name.localeCompare(b.item!.name, 'fr')))
  return groups
})

const craftSections = computed(() => plan.value ? [
  { key: 'direct', title: 'Base à craft', lines: sortCraftLines(plan.value.direct) },
  { key: 'subcrafts', title: 'Sous-crafts', lines: sortCraftLines(plan.value.subcrafts) },
  { key: 'ingredients', title: 'Ingrédients', lines: sortCraftLines([...plan.value.ingredients, ...plan.value.noncraftable]) },
] : [])
const currentChoice = computed(() => pendingChoices.value[0] || null)

function categoryTitle(category: ItemCategory): string {
  return category === 'Equipement' ? 'Équipements' : `${category}s`
}

function imageUrl(path: string, itemId?: number): string {
  if (itemId && cachedImageUrls.value.has(itemId)) return cachedImageUrls.value.get(itemId)!
  if (!path) return ''
  if (/^https?:\/\//.test(path)) return path
  return `/${path.replace(/\\/g, '/')}`
}

async function repairImage(event: Event, itemId: number): Promise<void> {
  const image = event.currentTarget as HTMLImageElement
  if (image.dataset.repairing || !data.value) return
  image.dataset.repairing = 'true'
  const item = data.value.items[String(itemId)]
  if (!item?.image_url) return
  const repaired = await syncCatalogImages({ ...data.value, items: { [String(itemId)]: { ...item, image_path: item.image_url } } })
  const url = repaired.get(itemId)
  if (url) {
    cachedImageUrls.value = new Map([...cachedImageUrls.value, [itemId, url]])
    image.src = url
  }
}

function setImagePath(itemIds: number[]): string {
  return data.value?.items[String(itemIds[0])]?.image_path || ''
}

function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window
}

async function checkAppUpdate(): Promise<void> {
  if (!isTauriRuntime() || checkingAppUpdate.value || installingAppUpdate.value) return
  checkingAppUpdate.value = true
  appUpdateProgress.value = ''
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) return
    appUpdate.value = update
    showAppUpdatePrompt.value = true
    await installAppUpdate()
  } catch {
    // An unavailable updater must never prevent offline use.
  } finally {
    checkingAppUpdate.value = false
  }
}

async function installAppUpdate(): Promise<void> {
  if (!appUpdate.value || installingAppUpdate.value) return
  installingAppUpdate.value = true
  appUpdateProgress.value = 'Téléchargement de la mise à jour...'
  let downloaded = 0
  let total: number | undefined
  try {
    await appUpdate.value.downloadAndInstall((event: any) => {
      if (event.event === 'Started') {
        total = event.data?.contentLength
      } else if (event.event === 'Progress') {
        downloaded += event.data?.chunkLength || 0
        appUpdateProgress.value = total
          ? `Téléchargement : ${Math.min(100, Math.round((downloaded / total) * 100))}%`
          : `Téléchargement : ${Math.round(downloaded / 1024 / 1024)} Mo`
      } else {
        appUpdateProgress.value = 'Installation terminée, redémarrage...'
      }
    })
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (error) {
    appUpdateProgress.value = `Mise à jour impossible : ${String(error)}`
  } finally {
    installingAppUpdate.value = false
  }
}

async function openDofusDb(itemId: number): Promise<void> {
  const url = `https://dofusdb.fr/database/object/${itemId}`
  if ('__TAURI_INTERNALS__' in window) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('open_external_url', { url })
      return
    } catch {
      // Browser fallback below.
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

function addItem(itemId: number, quantity = 1): void {
  selected.value = addSelectedItem(selected.value, itemId, quantity)
  query.value = ''
  status.value = 'Item ajouté'
}

function addSet(itemIds: number[], name: string): void {
  selected.value = addItemSet(selected.value, itemIds)
  query.value = ''
  status.value = `${name} ajoutée : ${itemIds.length} items`
}

function changeRequired(itemId: number, quantity: number): void {
  selected.value = setSelectedQuantity(selected.value, itemId, quantity)
}

function adjustRequired(event: WheelEvent, itemId: number, quantity: number): void {
  event.preventDefault()
  changeRequired(itemId, quantity + (event.deltaY < 0 ? 1 : -1))
}

function totalNeed(itemId: number): number {
  return allCraftLines.value.filter((line) => line.itemId === itemId).reduce((total, line) => total + line.quantity, 0)
}

function entryOwned(itemId: number): number {
  return craftAllocations.value[`direct:${itemId}`] || craftAllocations.value[`noncraftable:${itemId}`] || 0
}

function changeEntryOwned(itemId: number, quantity: number, maximum: number): void {
  const desired = Math.max(0, Math.min(Math.floor(Number(quantity) || 0), maximum))
  const globalQuantity = (owned.value[itemId] || 0) + desired - entryOwned(itemId)
  owned.value = setOwned(owned.value, itemId, globalQuantity, totalNeed(itemId))
}

function toggleEntry(itemId: number, maximum: number): void {
  changeEntryOwned(itemId, entryDone(itemId, maximum) ? 0 : maximum, maximum)
}

function entryDone(itemId: number, maximum: number): boolean {
  return entryOwned(itemId) >= maximum
}

function craftOwned(line: CraftLine): number {
  return craftAllocations.value[line.lineKey] || 0
}

function craftCovered(line: CraftLine): number {
  return craftCoverageAllocations.value[line.lineKey] || 0
}

function craftProgress(line: CraftLine): number {
  return Math.min(line.quantity, craftOwned(line) + craftCovered(line))
}

function sortCraftLines(lines: CraftLine[]): CraftLine[] {
  return [...lines].sort((a, b) =>
    Number(craftProgress(a) >= a.quantity) - Number(craftProgress(b) >= b.quantity)
      || a.name.localeCompare(b.name, 'fr'))
}

function toggleCraftLine(line: CraftLine): void {
  const complete = craftProgress(line) >= line.quantity
  if (line.role === 'direct' || line.role === 'subcraft') {
    const next = new Set(craftCheckedKeys.value)
    if (complete) next.delete(line.lineKey)
    else next.add(line.lineKey)
    craftCheckedKeys.value = next
  }
  if (complete && craftCovered(line) >= line.quantity && craftOwned(line) === 0) return
  const desiredOwned = complete ? 0 : Math.max(0, line.quantity - craftCovered(line))
  owned.value = setCraftLineAllocation(owned.value, allCraftLines.value, line.lineKey, desiredOwned)
}

function adjustEntryOwned(event: WheelEvent, itemId: number, maximum: number): void {
  event.preventDefault()
  changeEntryOwned(itemId, entryOwned(itemId) + (event.deltaY < 0 ? 1 : -1), maximum)
}

async function pasteItems(): Promise<void> {
  if (!data.value) return
  try {
    let text = ''
    if ('__TAURI_INTERNALS__' in window) {
      const { invoke } = await import('@tauri-apps/api/core')
      text = await invoke<string>('read_clipboard')
    } else {
      text = await navigator.clipboard.readText()
    }
    addParsedItems(text)
  } catch {
    status.value = 'Lecture du presse-papier indisponible'
    Notify.create({ type: 'warning', message: 'Lecture du presse-papier indisponible. Colle directement la liste dans la barre de recherche avec Ctrl+V.' })
  }
}

function addParsedItems(text: string, parsed = data.value ? parseItemList(data.value.items, data.value.itemSets, text) : null): void {
  if (!data.value) return
  if (!parsed) return
  parsed.found.forEach((entry) => { selected.value = addSelectedItem(selected.value, entry.itemId, entry.quantity) })
  pendingChoices.value = [...pendingChoices.value, ...parsed.choices]
  status.value = `${parsed.matchedLines} ligne(s) reconnue(s), ${parsed.found.length} item(s) ajouté(s)${parsed.matchedSets ? ` dont ${parsed.matchedSets} panoplie(s)` : ''}${parsed.choices.length ? `, ${parsed.choices.length} choix requis` : ''}${parsed.missed.length ? `, ${parsed.missed.length} ignorée(s)` : ''}`
  Notify.create({
    type: parsed.matchedLines ? (parsed.missed.length ? 'warning' : 'positive') : 'negative',
    message: status.value,
    caption: parsed.missed.length ? `Non reconnus ou ambigus : ${parsed.missed.slice(0, 3).join(' · ')}` : undefined,
    timeout: parsed.missed.length ? 6500 : 2500,
  })
}

function selectParsedChoice(option: ParsedChoiceOption): void {
  option.entries.forEach((entry) => {
    selected.value = addSelectedItem(selected.value, entry.itemId, entry.quantity)
  })
  pendingChoices.value = pendingChoices.value.slice(1)
}

function skipParsedChoice(): void {
  pendingChoices.value = pendingChoices.value.slice(1)
}

function pasteIntoSearch(event: ClipboardEvent): void {
  const text = event.clipboardData?.getData('text/plain') || ''
  if (!text || !data.value) return
  const parsed = parseItemList(data.value.items, data.value.itemSets, text)
  const looksLikeList = text.includes('\n') || text.includes('\t') || /[;,\r]/.test(text) || parsed.matchedLines > 0
  if (!looksLikeList) return
  event.preventDefault()
  query.value = ''
  addParsedItems(text, parsed)
}

function clearAll(): void {
  selected.value = []
  owned.value = {}
  craftCheckedKeys.value = new Set()
  pendingChoices.value = []
  craftOpen.value = false
  status.value = 'Liste vidée'
}

function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme.value
  localStorage.setItem('craftplanner-theme', theme.value)
}

function progress(category: ItemCategory): string {
  const rows = grouped.value[category]
  return `${rows.filter((entry) => entryDone(entry.itemId, entry.quantity)).length}/${rows.length}`
}

function quantityTotalWidth(category: ItemCategory): string {
  const digits = grouped.value[category].reduce((maximum, entry) =>
    Math.max(maximum, String(entry.quantity).length), 1)
  return `${10 + digits * 7}px`
}

function updateScrollClasses(): void {
  document.querySelectorAll<HTMLElement>('.selection-list, .item-list, .craft-list').forEach((list) => {
    list.classList.toggle('has-scroll', list.scrollHeight > list.clientHeight + 1)
  })
}

watch([selected, craftOpen], () => {
  void nextTick(() => {
    if (overflowFrame) cancelAnimationFrame(overflowFrame)
    overflowFrame = requestAnimationFrame(updateScrollClasses)
  })
}, { deep: true, flush: 'post' })

watch([selected, owned, craftCheckedKeys], () => {
  if (saveStateTimer) window.clearTimeout(saveStateTimer)
  saveStateTimer = window.setTimeout(persistPlannerState, 120)
}, { flush: 'post' })

onMounted(async () => {
  window.addEventListener('beforeunload', persistPlannerState)
  theme.value = localStorage.getItem('craftplanner-theme') === 'light' ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme.value
  try {
    data.value = await loadCatalogData()
    cachedImageUrls.value = await syncCatalogImages({ ...data.value, items: {} })
    const saved = await loadPlannerState().catch(() => null)
    if (saved) {
      selected.value = saved.selected || []
      owned.value = saved.owned || {}
      craftCheckedKeys.value = new Set(saved.craftCheckedKeys || [])
    }
    status.value = `${Object.keys(data.value.items).length} items, ${Object.keys(data.value.recipes).length} recettes, ${Object.keys(data.value.itemSets).length} panoplies chargés`
    void checkCatalogStatus(data.value).then(async (info) => {
      if (!info.needsSync) return
      status.value = `Mise à jour disponible : ${info.labels.join(', ')}`
      if (data.value) {
        if (info.labels.some((label) => label !== 'images')) {
          if ('__TAURI_INTERNALS__' in window) {
            data.value = await syncCatalogData(data.value, (message) => { status.value = message })
          }
        }
        if (info.labels.includes('images') || '__TAURI_INTERNALS__' in window) {
          cachedImageUrls.value = await syncCatalogImages(data.value, (message) => { status.value = message })
          status.value = 'Données synchronisées'
        }
      }
    }).catch(() => undefined)
  } catch (error) {
    status.value = `Chargement impossible : ${String(error)}`
  } finally {
    loading.value = false
  }
  await checkAppUpdate()
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', persistPlannerState)
  persistPlannerState()
})
</script>

<template>
  <div class="app-shell">
    <main class="workspace" :class="{ 'craft-mode': craftOpen }">
      <aside class="selection-sidebar glass-surface">
        <section class="selection-top">
          <section class="search-block">
            <q-input v-model="query" dense standout clearable placeholder="Rechercher un item ou une panoplie..." :disable="loading" @paste="pasteIntoSearch">
              <template #prepend>
                <button class="search-icon-button" type="button" :aria-label="theme === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre'" @click.stop="toggleTheme">
                  <q-icon :name="theme === 'dark' ? 'light_mode' : 'dark_mode'" />
                </button>
                <q-icon name="search" />
              </template>
              <template #append>
                <button class="search-icon-button" type="button" aria-label="Coller une liste" @click.stop="pasteItems"><q-icon name="content_paste" /></button>
                <button class="search-icon-button" type="button" aria-label="Vider" @click.stop="clearAll"><q-icon name="delete_sweep" /></button>
              </template>
            </q-input>
            <div v-if="query && results.length" class="search-results">
              <button v-for="result in results" :key="result.kind === 'item' ? `i:${result.item.id}` : `s:${result.itemSet.id}`" class="result-row" type="button"
                @click="result.kind === 'item' ? addItem(result.item.id) : addSet(result.itemSet.item_ids, result.itemSet.name)">
                <span class="result-icon">
                  <img v-if="result.kind === 'item' ? result.item.image_path : setImagePath(result.itemSet.item_ids)"
                    :src="imageUrl(result.kind === 'item' ? result.item.image_path : setImagePath(result.itemSet.item_ids), result.kind === 'item' ? result.item.id : result.itemSet.item_ids[0])"
                    alt="" @error="repairImage($event, result.kind === 'item' ? result.item.id : result.itemSet.item_ids[0])">
                  <q-icon v-else :name="result.kind === 'item' ? 'inventory_2' : 'apps'" />
                </span>
                <span>{{ result.kind === 'item' ? result.item.name : result.itemSet.name }}</span>
                <small>{{ result.kind === 'item' ? result.item.type_name || result.item.raw_type : `${result.itemSet.item_ids.length} items` }}</small>
              </button>
            </div>
          </section>
          <div class="panel-heading"><h2>Liste sélectionnée</h2><q-badge rounded>{{ selected.length }}</q-badge></div>
        </section>

        <div class="selection-list">
          <p v-if="!entries.length" class="empty-state">Ajoute des items, une panoplie ou colle une liste</p>
          <article v-for="entry in entries" :key="entry.itemId" class="selection-chip">
            <button class="selection-entry-link" type="button" @click="openDofusDb(entry.itemId)">
              <img v-if="entry.item!.image_path" :src="imageUrl(entry.item!.image_path, entry.itemId)" alt="" @error="repairImage($event, entry.itemId)">
              <span><strong>{{ entry.item!.name }}</strong><small>{{ entry.item!.type_name || entry.item!.raw_type }}</small></span>
            </button>
            <input type="number" min="0" :value="entry.quantity" aria-label="Quantité requise"
              @wheel.stop="adjustRequired($event, entry.itemId, entry.quantity)" @change="changeRequired(entry.itemId, Number(($event.target as HTMLInputElement).value))">
            <q-btn dense round flat icon="close" @click="changeRequired(entry.itemId, 0)" />
          </article>
        </div>
      </aside>

      <section class="main-board">
        <div class="item-columns" :aria-hidden="craftOpen">
          <article v-for="category in ITEM_CATEGORIES" :key="category" class="item-column glass-surface"
            :style="{ '--quantity-total-width': quantityTotalWidth(category) }">
            <header class="column-heading"><h2>{{ categoryTitle(category) }}</h2><q-badge rounded>{{ progress(category) }}</q-badge></header>
            <div v-if="grouped[category].length" class="item-list">
              <article v-for="entry in grouped[category]" :key="entry.itemId" class="item-row" :class="{ done: entryDone(entry.itemId, entry.quantity) }" :data-item-id="entry.itemId">
                <input type="checkbox" :checked="entryDone(entry.itemId, entry.quantity)" @change="toggleEntry(entry.itemId, entry.quantity)">
                <div class="item-card">
                  <button class="item-link" type="button" @click="openDofusDb(entry.itemId)">
                    <img v-if="entry.item!.image_path" :src="imageUrl(entry.item!.image_path, entry.itemId)" alt="" @error="repairImage($event, entry.itemId)">
                    <span class="item-copy"><strong>{{ entry.item!.name }}</strong><small>{{ entry.item!.type_name || entry.item!.raw_type }}</small></span>
                  </button>
                  <input class="owned-input" type="number" min="0" :max="entry.quantity" :value="entryOwned(entry.itemId)" aria-label="Quantité possédée"
                    @wheel.stop="adjustEntryOwned($event, entry.itemId, entry.quantity)" @change="changeEntryOwned(entry.itemId, Number(($event.target as HTMLInputElement).value), entry.quantity)">
                  <span class="quantity-total">/ {{ entry.quantity }}</span>
                </div>
              </article>
            </div>
            <p v-else class="empty-state">Aucun item</p>
          </article>
        </div>

        <aside class="craft-panel glass-surface" :class="{ open: craftOpen }">
          <button v-if="!craftOpen" class="craft-rail" type="button" :disabled="!selected.length" @click="craftOpen = true">
            <span class="rail-title">Plan craft</span><span class="rail-badge">{{ allCraftLines.length }}</span>
          </button>
          <div v-else class="craft-expanded">
            <header class="craft-heading"><q-btn dense round flat icon="close" @click="craftOpen = false" /><h2>Plan de craft</h2><q-badge rounded>{{ allCraftLines.filter(line => craftProgress(line) >= line.quantity).length }}/{{ allCraftLines.length }}</q-badge></header>
            <div class="craft-grid">
              <section v-for="section in craftSections" :key="section.key" class="craft-section">
                <header><h3>{{ section.title }}</h3><span>{{ section.lines.filter(line => craftProgress(line) >= line.quantity).length }}/{{ section.lines.length }}</span></header>
                <div class="craft-list">
                  <p v-if="!section.lines.length" class="empty-state compact">Aucun item</p>
                  <article v-for="line in section.lines" :key="line.lineKey" class="craft-row" :class="{ done: craftProgress(line) >= line.quantity }"
                    :data-item-id="line.itemId" :data-line-key="line.lineKey">
                    <input type="checkbox" :checked="craftProgress(line) >= line.quantity" @change="toggleCraftLine(line)">
                    <button class="item-card" type="button" @click="openDofusDb(line.itemId)">
                      <img v-if="line.imagePath" :src="imageUrl(line.imagePath, line.itemId)" alt="" @error="repairImage($event, line.itemId)">
                      <span class="item-copy"><strong>{{ craftProgress(line) }}/{{ line.quantity }} x {{ line.name }}</strong><small>{{ line.rawType }}</small></span>
                    </button>
                  </article>
                </div>
              </section>
            </div>
          </div>
        </aside>
      </section>
    </main>

    <div v-if="showAppUpdatePrompt && appUpdate" class="sync-dialog">
      <section class="sync-card glass-surface">
        <h2>Mise à jour nécessaire</h2>
        <p>
          La version {{ appUpdate.version }} est disponible. CraftPlanner l'installe maintenant,
          puis redémarre automatiquement.
        </p>
        <p v-if="appUpdateProgress" class="update-progress">{{ appUpdateProgress }}</p>
      </section>
    </div>

    <div v-if="currentChoice" class="choice-dialog">
      <section class="choice-card glass-surface">
        <header>
          <div>
            <span class="choice-kicker">Choix requis</span>
            <h2>Quel item ajouter ?</h2>
          </div>
          <q-btn dense round flat icon="close" aria-label="Ignorer ce choix" @click="skipParsedChoice" />
        </header>
        <p>{{ currentChoice.source }}</p>
        <div class="choice-options">
          <button v-for="option in currentChoice.options" :key="option.label" class="choice-option" type="button" @click="selectParsedChoice(option)">
            <span class="choice-visual">
              <img v-if="option.imagePath" :src="imageUrl(option.imagePath, option.entries[0]?.itemId)" alt=""
                @error="repairImage($event, option.entries[0]?.itemId)">
              <q-icon v-else name="inventory_2" />
            </span>
            <span class="choice-copy">
              <strong>{{ currentChoice.quantity }} x {{ option.label }}</strong>
              <small>{{ option.typeName }}</small>
            </span>
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
