import { chromium } from 'playwright-core'

const url = process.env.CRAFTPLANNER_URL || 'http://127.0.0.1:5175'
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
})
const errors = []
const remoteImageRequests = []

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  await context.addInitScript(() => {
    sessionStorage.setItem('craftplanner-smoke-mode', '1')
  })
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico') && !response.url().includes('image-volontairement-manquante.png')) {
      errors.push(`HTTP ${response.status()}: ${response.url()}`)
    }
  })
  page.on('request', (request) => {
    const requestUrl = request.url()
    if (requestUrl.startsWith('https://api.dofusdb.fr/img/')) remoteImageRequests.push(requestUrl)
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.evaluate(() => new Promise((resolve) => {
    const request = indexedDB.deleteDatabase('craftplanner')
    request.onsuccess = resolve
    request.onerror = resolve
    request.onblocked = resolve
  }))
  await page.evaluate(() => localStorage.removeItem('craftplanner-state'))
  await page.reload({ waitUntil: 'networkidle' })

  await page.getByPlaceholder('Rechercher un item ou une panoplie...').evaluate((input) => {
    input.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    }))
  })
  await page.getByPlaceholder('Rechercher un item ou une panoplie...').evaluate((input) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'Coiffe du Bouftou\t2\nCape Bouffante x 3\n• Marteau du Bouftou:4')
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  })
  await page.waitForFunction(() => document.querySelectorAll('.selection-chip').length === 3)
  const pastedQuantities = await page.locator('.selection-chip input[type="number"]').allTextContents()
  const pastedValues = await page.locator('.selection-chip input[type="number"]').evaluateAll((inputs) => inputs.map((input) => input.value))
  if (JSON.stringify(pastedValues) !== JSON.stringify(['2', '3', '4'])) {
    throw new Error(`Le collage tabulaire/multiligne donne des quantités incorrectes: ${pastedQuantities.join(', ')}`)
  }
  await page.getByLabel('Vider').click()
  await page.getByPlaceholder('Rechercher un item ou une panoplie...').evaluate((input) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'Coiffe du Bouftou x 5')
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  })
  await page.waitForFunction(() => document.querySelector('.selection-chip input[type="number"]')?.value === '5')
  await page.getByLabel('Vider').click()
  await page.getByPlaceholder('Rechercher un item ou une panoplie...').evaluate((input) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', '2 x Panoplie du Bouftou')
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  })
  await page.waitForFunction(() => document.querySelectorAll('.selection-chip').length === 8)
  if ([...await page.locator('.selection-chip input[type="number"]').evaluateAll((inputs) => inputs.map((input) => input.value))].some((value) => value !== '2')) {
    throw new Error('La quantité d’une panoplie collée n’est pas appliquée à tous ses items')
  }
  await page.getByPlaceholder('Rechercher un item ou une panoplie...').evaluate((input) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'Coiffe du Bouftou x 3')
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  })
  await page.waitForFunction(() => [...document.querySelectorAll('.selection-chip')].some((row) =>
    row.querySelector('strong')?.textContent === 'Coiffe du Bouftou' && row.querySelector('input')?.value === '5'))
  await page.getByLabel('Vider').click()
  await page.getByPlaceholder('Rechercher un item ou une panoplie...').evaluate((input) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', '35 x Or.\n10 x Graine de Scorbute (commentaire).\n3 x Mandragorre.\n1 x Slip (item équipable, vous ne le perdez pas).\n5 x Oeil de Verminocule.\n25 x Pomme de Terre ou Pommes de Terre épluchées.')
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  })
  await page.waitForFunction(() => document.querySelectorAll('.selection-chip').length === 4 && document.querySelector('.choice-dialog'))
  await page.locator('.choice-option').filter({ hasText: 'Pomme de Terre' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.selection-chip').length === 5 && !document.querySelector('.choice-dialog'))
  if (await page.locator('.selection-chip').filter({ hasText: 'Pommes de Terre épluchées' }).count()) {
    throw new Error('Le choix alternatif a ajouté les deux options')
  }
  await page.getByLabel('Vider').click()

  await page.getByPlaceholder('Rechercher un item ou une panoplie...').fill('Panoplie du Bouftou')
  if (!await page.locator('.result-icon').count()) throw new Error('Les résultats de recherche n’affichent aucune icône')
  await page.getByRole('button', { name: 'Panoplie du Bouftou 8 items', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.selection-chip').length === 8)
  if (await page.locator('.item-row').count() !== 8) throw new Error('La panoplie ne contient pas 8 items individuels')
  if (await page.locator('.status-bar').count()) throw new Error('L’ancien bandeau de statut est encore affiché')
  if (await page.locator('.selection-entry-link').count() !== 8) throw new Error('Les items sélectionnés ne sont pas tous cliquables')

  const firstItemId = await page.locator('.item-row').first().getAttribute('data-item-id')
  const firstRow = page.locator(`.item-row[data-item-id="${firstItemId}"]`)
  const firstImage = firstRow.locator('img')
  if (await firstImage.count()) {
    await firstImage.evaluate((image) => { image.src = '/cache/images/image-volontairement-manquante.png' })
    await page.waitForTimeout(500)
    const repairedSrc = await firstImage.getAttribute('src')
    if (repairedSrc?.startsWith('blob:')) throw new Error('Une image locale cassée déclenche encore une réparation distante')
  }
  const firstOwned = firstRow.locator('.owned-input')
  await firstOwned.fill('1')
  await firstOwned.press('Enter')
  await page.waitForFunction((itemId) => document.querySelector(`.item-row[data-item-id="${itemId}"]`)?.classList.contains('done'), firstItemId)
  if (await page.locator('.item-row').last().getAttribute('data-item-id') !== firstItemId) {
    throw new Error('Un item terminé ne descend pas en bas de sa colonne')
  }
  await firstOwned.fill('0')
  await firstOwned.press('Enter')
  await page.waitForFunction((itemId) => !document.querySelector(`.item-row[data-item-id="${itemId}"]`)?.classList.contains('done'), firstItemId)

  const firstRequired = page.locator('.selection-chip input[type="number"]').first()
  await firstRequired.hover()
  await page.mouse.wheel(0, -100)
  await page.waitForFunction(() => document.querySelector('.selection-chip input[type="number"]')?.value === '2')
  await page.mouse.wheel(0, 100)
  await page.waitForFunction(() => document.querySelector('.selection-chip input[type="number"]')?.value === '1')
  await firstRequired.hover()
  await page.mouse.wheel(0, -100)
  await page.waitForFunction(() => document.querySelector('.selection-chip input[type="number"]')?.value === '2')

  await page.locator('.craft-rail').click()
  await page.waitForFunction(() => document.querySelectorAll('.craft-row').length > 0)
  const craftRows = await page.locator('.craft-row').count()
  const firstCraftId = await page.locator('.craft-row').first().getAttribute('data-item-id')
  const firstCraftLine = await page.locator('.craft-row').first().getAttribute('data-line-key')
  const partialCraftLine = await page.locator('.craft-row').evaluateAll((rows) => {
    const row = rows.find((candidate) => {
      const key = candidate.getAttribute('data-line-key') || ''
      return /^(direct|subcraft):/.test(key) && Number(candidate.getAttribute('data-quantity') || '0') > 1
    })
    return row?.getAttribute('data-line-key') || ''
  })
  if (!partialCraftLine) throw new Error('Aucune ligne craftable partielle disponible pour vérifier la propagation des ingrédients')
  const partialCraftInput = page.locator(`.craft-row[data-line-key="${partialCraftLine}"] .owned-input`)
  await partialCraftInput.fill('0')
  await partialCraftInput.press('Enter')
  const partialIngredientProgressBefore = await page.locator('.craft-section').last().locator('.craft-row').evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-progress')))
  await partialCraftInput.hover()
  await page.mouse.wheel(0, -100)
  await page.waitForFunction(
    (lineKey) => document.querySelector(`.craft-row[data-line-key="${lineKey}"] .owned-input`)?.value === '1',
    partialCraftLine,
  )
  await page.waitForFunction(
    (before) => JSON.stringify([...document.querySelectorAll('.craft-section:last-child .craft-row')].map((row) => row.getAttribute('data-progress'))) !== JSON.stringify(before),
    partialIngredientProgressBefore,
  )
  await page.waitForTimeout(700)
  await page.locator(`.craft-row[data-line-key="${partialCraftLine}"] .owned-input`).hover()
  await page.mouse.wheel(0, 100)
  await page.waitForFunction(
    (lineKey) => document.querySelector(`.craft-row[data-line-key="${lineKey}"] .owned-input`)?.value === '0',
    partialCraftLine,
  )
  const ingredientProgressBefore = await page.locator('.craft-section').last().locator('.craft-row').evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-progress')))
  await page.locator(`.craft-row[data-line-key="${firstCraftLine}"] input[type="checkbox"]`).click()
  await page.waitForFunction(
    (lineKey) => {
      const input = document.querySelector(`.craft-row[data-line-key="${lineKey}"] .owned-input`)
      const max = input?.getAttribute('max')
      return input && max && input.value === max
    },
    firstCraftLine,
  )
  await page.waitForFunction(
    (before) => JSON.stringify([...document.querySelectorAll('.craft-section:last-child .craft-row')].map((row) => row.getAttribute('data-progress'))) !== JSON.stringify(before),
    ingredientProgressBefore,
  )
  const ingredientProgressAfter = await page.locator('.craft-section').last().locator('.craft-row').evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-progress')))
  await page.locator('.craft-heading .q-btn').click()
  if (!await page.locator(`.item-row[data-item-id="${firstCraftId}"]`).evaluate((row) => row.classList.contains('done'))) {
    throw new Error('Un craft principal terminé ne synchronise pas la liste principale')
  }
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForFunction(() => document.querySelectorAll('.selection-chip').length === 8)
  const restoredImageSrc = await page.locator(`.item-row[data-item-id="${firstItemId}"] img`).first().getAttribute('src').catch(() => '')
  if (restoredImageSrc?.startsWith('http')) throw new Error('Une image distante est utilisée après rechargement')
  if (!await page.locator(`.item-row[data-item-id="${firstCraftId}"]`).evaluate((row) => row.classList.contains('done'))) {
    throw new Error('Les quantités possédées ne survivent pas au rechargement')
  }
  await page.locator('.craft-rail').click()
  await page.waitForFunction(() => document.querySelectorAll('.craft-row').length > 0)
  if (!await page.locator(`.craft-row[data-line-key="${firstCraftLine}"]`).evaluate((row) => row.classList.contains('done'))) {
    throw new Error('Le plan de craft ne retrouve pas son état après réouverture')
  }
  const restoredIngredientProgress = await page.locator('.craft-section').last().locator('.craft-row').evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-progress')))
  if (JSON.stringify(restoredIngredientProgress) !== JSON.stringify(ingredientProgressAfter)) {
    throw new Error('La couverture des ingrédients ne survit pas au rechargement')
  }

  if (errors.length) throw new Error(`Erreurs navigateur: ${errors.join(' | ')}`)
  if (remoteImageRequests.length) throw new Error(`Requêtes images distantes interdites: ${remoteImageRequests.slice(0, 5).join(', ')}`)
  console.log(`Smoke OK: panoplie 8 items, ${craftRows} lignes de craft, quantités fines synchronisées`)
} finally {
  await browser.close()
}
