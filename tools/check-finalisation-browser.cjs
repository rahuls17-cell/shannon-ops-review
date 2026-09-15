const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors = [];
    page.on('pageerror',e => errors.push(e.message));
    await page.goto(process.env.DASHBOARD_URL || 'http://127.0.0.1:8787/');
    await page.waitForFunction(() => document.querySelector('#metricAccepted').textContent !== '-', null, {timeout:60000});
    await page.click('[data-view="finalisation"]');
    async function check() {
      const rows = await page.locator('#finalisationRows tr:not(:has(.empty))').count();
      const value = await page.locator('#finalisationSummary strong').first().innerText();
      assert.equal(Number(value.replaceAll(',','')), rows);
      const cards = await page.locator('#finalisationSummary strong').allTextContents();
      assert.equal(Number(cards[2].replaceAll(',',''))+Number(cards[3].replaceAll(',','')),rows);
      return rows;
    }
    const original = await check();
    console.log('Default Finalisation folders:',original);
    await page.selectOption('#duplicateFilter','duplicates');
    await check();
    assert.equal(await page.locator('#finalisationRows').innerText().then(t => t.includes('Current pipeline /')),false);
    await page.selectOption('#finalisationSourceFilter','');
    console.log('Both sources, extra duplicates:',await check());
    await page.click('#resetFinalisationFilters');
    assert.equal(await check(),original);
    await page.selectOption('#finalisationType','Connector');
    await page.selectOption('#finalisationDomain','Not recorded');
    await page.selectOption('#finalisationOwnership','linked');
    assert.ok(await check()>0);
    await page.fill('#finalisationSearch','no-task-could-match-this-string');
    assert.equal(await check(),0);
    await page.click('#resetFinalisationFilters');
    await page.fill('#finalisationStart','2026-09-16');
    await page.fill('#finalisationEnd','2026-09-15');
    assert.equal(await check(),0);
    assert.equal(await page.locator('#finalisationDateError').isVisible(),true);
    await page.click('#resetFinalisationFilters');
    await page.selectOption('#teamFilter','Company');
    await page.click('#resetFinalisationFilters');
    assert.equal(await page.locator('#teamFilter').inputValue(),'Company');
    await check();
    await page.click('#resetFilters');
    assert.equal(await check(),original);
    await page.screenshot({path:'D:/turing/tmp/finalisation-filters-desktop.png'});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'D:/turing/tmp/finalisation-filters-mobile.png'});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
    assert.deepEqual(errors,[]);
    console.log('Browser passed: rows equal cards, explicit source, combined filters, date errors, reset scope and mobile width.');
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
