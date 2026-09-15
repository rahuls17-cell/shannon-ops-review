const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({channel:'msedge', headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.DASHBOARD_URL || 'http://127.0.0.1:8787/');
    await page.waitForFunction(() => document.querySelector('#metricAccepted').textContent !== '-' && document.querySelector('#commandSummary').textContent.includes('Finalisation folders'), null, {timeout:60000});
    const metrics = await page.locator('#commandSummary').innerText();
    console.log(metrics);
    const current = await page.locator('#pipelineDonut .donut-label strong').innerText();
    await page.click('[data-view="pipeline"]');
    await page.selectOption('#pipelineMode','historical');
    await page.click('[data-view="command"]');
    assert.equal(await page.locator('#pipelineDonut .donut-label strong').innerText(), current);
    const accepted = await page.locator('#metricAccepted').innerText();
    await page.selectOption('#teamFilter','Company');
    console.log('Company accepted:', await page.locator('#metricAccepted').innerText());
    await page.click('#resetFilters');
    assert.equal(await page.locator('#metricAccepted').innerText(), accepted);
    await page.screenshot({path:'D:/turing/tmp/command-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'D:/turing/tmp/command-mobile.png',fullPage:true});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile horizontal overflow');
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: both feeds loaded, scope filters, history independence, mobile width, no JS errors.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
