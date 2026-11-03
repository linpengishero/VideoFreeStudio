// Browser regression for post-process task editing; uses mocked gateway data only.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('../frontend/node_modules/playwright');

(async () => {
  const root = path.resolve(__dirname, '../frontend');
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')));
  const { default: vue } = await import(pathToFileURL(path.join(root, 'node_modules/@vitejs/plugin-vue/dist/index.mjs')));
  const fixture = {
    name: 'task-detail-editor-regression',
    resolveId(id) { if (id === 'virtual:task-detail-editor') return id; },
    load(id) {
      if (id !== 'virtual:task-detail-editor') return;
      return `
        import { createApp, h, ref } from 'vue';
        import TaskDetailModal from '/src/components/TaskDetailModal.vue';
        import { gateway } from '/src/services/api.js';
        import { setLocale } from '/src/services/i18n.js';
        import '/src/ui.css';
        setLocale('zh-CN');
        gateway.pluginActions = async () => ({items:[]});
        gateway.pluginAction = async () => ({id:'demo.process',name:'Video enhancement',scope:'resource',plugin_id:'demo',ui:{version:1,fields:[]}});
        let sourceManifest = {task_id:'parent',parameters:{prompt:'source prompt',params:{confirmed_prompt_zh:'中文确认稿',execution_prompt_en:'English execution draft'}},inputs:[]};
        gateway.jobManifest = async () => sourceManifest;
        const manifest = ref({task_id:'child',parent_task_id:'parent',kind:'video',status:'completed',project_id:'p',inputs:[{task_id:'child',type:'audio',index:0,path:'voice.wav',name:'voice.wav'}],parameters:{params:{capability_id:'demo.post',confirmed_prompt_zh:'中文确认稿',execution_prompt_en:'English execution draft'},generation:{mode_id:'demo.process',action_inputs:{}}}});
        const capability = {id:'demo.post',plugin_id:'demo',kind:'video',operation:'postprocess',model_name:'Demo',ui:{fields:[],edit:{}}};
        window.setManifest = value => { manifest.value = value; };
        window.setParentManifest = value => { sourceManifest = value; };
        createApp({render:()=>h(TaskDetailModal,{manifest:manifest.value,capabilities:[capability],voices:[],applications:[],onClose:()=>{}})}).mount('#app');`;
    },
  };
  const server = await createServer({ root, configFile:false, plugins:[vue(),fixture], optimizeDeps:{noDiscovery:true,include:['vue']}, server:{host:'127.0.0.1',port:0} });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({channel:'chrome',headless:true});
    const page = await browser.newPage({viewport:{width:1200,height:850}});
    page.setDefaultTimeout(10000);
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/task-detail-test',route=>route.fulfill({contentType:'text/html',body:'<div id="app"></div><script type="module" src="/@id/virtual:task-detail-editor"></script>'}));
    await page.goto(`${server.resolvedUrls.local[0]}task-detail-test`);
    const dialog=page.getByRole('dialog',{name:'编辑并重新生成'});
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('tab',{name:'中文方案'}).count(),1);
    assert.equal(await dialog.getByRole('tab',{name:'英文执行稿'}).count(),1);
    let prompt=dialog.locator('.task-prompt-editor textarea');
    assert.equal(await prompt.inputValue(),'English execution draft');
    await dialog.getByRole('tab',{name:'中文方案'}).click();
    assert.equal(await prompt.inputValue(),'中文确认稿');
    await dialog.getByRole('tab',{name:'英文执行稿'}).click();
    assert.equal(await prompt.inputValue(),'English execution draft');
    const audio=dialog.locator('.task-audio-preview');
    const box=await audio.boundingBox();
    assert.ok(box && Math.abs(box.width-box.height)<=1,`audio preview should be square: ${JSON.stringify(box)}`);
    assert.equal(await audio.evaluate(el=>getComputedStyle(el).width),'56px');

    await page.evaluate(()=>{window.setParentManifest({task_id:'parent',parameters:{params:{confirmed_prompt_zh:'只有中文稿'}},inputs:[]});window.setManifest({task_id:'child-zh',parent_task_id:'parent',kind:'video',status:'completed',inputs:[],parameters:{params:{capability_id:'demo.post',confirmed_prompt_zh:'只有中文稿'},generation:{mode_id:'demo.process',action_inputs:{}}}});});
    await page.waitForFunction(()=>document.querySelector('.task-prompt-editor textarea')?.value==='只有中文稿');
    assert.equal(await dialog.getByRole('tab',{name:'中文方案'}).count(),0,'language tabs stay hidden without a complete bilingual pair');
    assert.equal(await dialog.getByRole('tab',{name:'英文执行稿'}).count(),0);
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();
    await server.close();
  }
  process.stdout.write('Task editor regression passed: post-process bilingual switching, single-language fallback, and compact audio preview.\n');
})().catch(error=>{console.error(error);process.exitCode=1;});
