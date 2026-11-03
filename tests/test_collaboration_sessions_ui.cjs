// Isolated collaboration-session regressions: no gateway or runtime-data writes.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('../frontend/node_modules/playwright');

(async () => {
  const root = path.resolve(__dirname, '../frontend');
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')));
  const { default: vue } = await import(pathToFileURL(path.join(root, 'node_modules/@vitejs/plugin-vue/dist/index.mjs')));
  const fixture = {
    name: 'collaboration-sessions-regressions',
    resolveId(id) { if (id === 'virtual:collaboration-fixture') return id; },
    load(id) {
      if (id !== 'virtual:collaboration-fixture') return;
      return `
        import { createApp, h } from 'vue';
        import Composer from '/src/components/PluginComposer.vue';
        import { gateway } from '/src/services/api.js';
        import '/src/ui.css';
        const current={id:'collab-current',project_id:'project-a',capability_id:'video.test',mode_id:'reference',status:'running'};
        const other={id:'collab-other',project_id:'project-a',capability_id:'video.test',mode_id:'reference',status:'awaiting_confirmation'};
        let collaborationCalls=0,resolveLate;
        gateway.collaborations=async()=>({items:[current,other]});
        gateway.collaboration=async()=>++collaborationCalls===1?current:new Promise(resolve=>resolveLate=resolve);
        gateway.cancelCollaboration=async id=>({...current,id,status:'cancelled'});
        window.fixture={resolvePoll:()=>resolveLate?.(current),getCalls:()=>collaborationCalls};
        localStorage.setItem('videofree-form-session-project-a-all-video.test',JSON.stringify(current));
        const selected={id:'video.test',plugin_id:'test',name:'Test video',inputs:{},processing_modes:[{id:'direct',name:'Direct'}],ui:{version:1,fields:[]}};
        createApp({render:()=>h(Composer,{selected,categories:[],capabilities:[selected],projectId:'project-a',categoryId:'',voices:[]})}).mount('#app');`;
    },
  };
  const server = await createServer({root,configFile:false,plugins:[vue(),fixture],optimizeDeps:{noDiscovery:true,include:['vue']},server:{host:'127.0.0.1',port:0}});
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true});
    const page = await browser.newPage({viewport:{width:1000,height:720}});
    page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/collaboration-test',route=>route.fulfill({contentType:'text/html',body:'<div id="app"></div><script type="module" src="/@id/virtual:collaboration-fixture"></script>'}));
    await page.goto(server.resolvedUrls.local[0]+'collaboration-test');
    await page.getByRole('complementary',{name:'Collaboration panel'}).waitFor();

    assert.equal(await page.getByRole('region',{name:'Collaboration sessions'}).count(),0);
    await page.getByRole('button',{name:'Switch collaboration (2)'}).click();
    const sessions=page.getByRole('region',{name:'Collaboration sessions'});
    await sessions.waitFor();
    assert.equal(await sessions.getByText('Running',{exact:true}).count(),1);
    assert.equal(await sessions.getByText('reference',{exact:true}).count(),0);

    await page.waitForFunction(()=>fixture.getCalls()>=2);
    await page.getByRole('button',{name:'Cancel current job'}).click();
    await page.evaluate(()=>fixture.resolvePoll());
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>localStorage.getItem('videofree-form-session-project-a-all-video.test')),null);
    assert.equal(await page.locator('.plugin-collaboration-fallback').count(),0);
    assert.deepEqual(errors,[]);
    console.log('Collaboration sessions passed: collapsed list, localized status, cancel invalidates stale poll/cache.');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1});
