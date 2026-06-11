import { chromium } from 'playwright-core'

const url = process.env.CRAFTPLANNER_URL || 'http://127.0.0.1:5175'
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
})
const errors = []

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
      errors.push(`HTTP ${response.status()}: ${response.url()}`)
    }
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
  if (!await page.locator('.result-icon img').count()) throw new Error('Les résultats de recherche n’affichent aucune icône')
  await page.getByRole('button', { name: 'Panoplie du Bouftou 8 items', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.selection-chip').length === 8)
  if (await page.locator('.item-row').count() !== 8) throw new Error('La panoplie ne contient pas 8 items individuels')
  if (await page.locator('.status-bar').count()) throw new Error('L’ancien bandeau de statut est encore affiché')
  if (await page.locator('.selection-entry-link').count() !== 8) throw new Error('Les items sélectionnés ne sont pas tous cliquables')

  const firstItemId = await page.locator('.item-row').first().getAttribute('data-item-id')
  const firstRow = page.locator(`.item-row[data-item-id="${firstItemId}"]`)
  const firstImage = firstRow.locator('img')
  await firstImage.evaluate((image) => { image.src = '/cache/images/image-volontairement-manquante.png' })
  await page.waitForFunction((itemId) =>
    document.querySelector(`.item-row[data-item-id="${itemId}"] img`)?.getAttribute('src')?.startsWith('blob:'), firstItemId)
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

  await page.locator('.craft-rail').click()
  await page.waitForFunction(() => document.querySelectorAll('.craft-row').length > 0)
  const craftRows = await page.locator('.craft-row').count()
  const firstCraftId = await page.locator('.craft-row').first().getAttribute('data-item-id')
  const firstCraftLine = await page.locator('.craft-row').first().getAttribute('data-line-key')
  const ingredientProgressBefore = await page.locator('.craft-section').last().locator('.craft-row strong').allTextContents()
  await page.locator(`.craft-row[data-line-key="${firstCraftLine}"] input[type="checkbox"]`).click()
  await page.waitForFunction(
    (before) => JSON.stringify([...document.querySelectorAll('.craft-section:last-child .craft-row strong')].map((node) => node.textContent)) !== JSON.stringify(before),
    ingredientProgressBefore,
  )
  const ingredientProgressAfter = await page.locator('.craft-section').last().locator('.craft-row strong').allTextContents()
  await page.locator('.craft-heading .q-btn').click()
  if (!await page.locator(`.item-row[data-item-id="${firstCraftId}"]`).evaluate((row) => row.classList.contains('done'))) {
    throw new Error('Un craft principal terminé ne synchronise pas la liste principale')
  }
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForFunction(() => document.querySelectorAll('.selection-chip').length === 8)
  await page.waitForFunction((itemId) =>
    document.querySelector(`.item-row[data-item-id="${itemId}"] img`)?.getAttribute('src')?.startsWith('blob:'), firstItemId)
  if (!await page.locator(`.item-row[data-item-id="${firstCraftId}"]`).evaluate((row) => row.classList.contains('done'))) {
    throw new Error('Les quantités possédées ne survivent pas au rechargement')
  }
  await page.locator('.craft-rail').click()
  await page.waitForFunction(() => document.querySelectorAll('.craft-row').length > 0)
  if (!await page.locator(`.craft-row[data-line-key="${firstCraftLine}"]`).evaluate((row) => row.classList.contains('done'))) {
    throw new Error('Le plan de craft ne retrouve pas son état après réouverture')
  }
  if (JSON.stringify(await page.locator('.craft-section').last().locator('.craft-row strong').allTextContents()) !== JSON.stringify(ingredientProgressAfter)) {
    throw new Error('La couverture des ingrédients ne survit pas au rechargement')
  }

  if (errors.length) throw new Error(`Erreurs navigateur: ${errors.join(' | ')}`)
  console.log(`Smoke OK: panoplie 8 items, ${craftRows} lignes de craft, quantités fines synchronisées`)
} finally {
  await browser.close()
}
