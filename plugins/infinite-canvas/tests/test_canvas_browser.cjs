const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('../../../frontend/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const vue = path.resolve(root, '../../frontend/node_modules/vue/dist/vue.esm-browser.js');
const plugin = path.join(root, 'ui/dist/index.js');
const capability = {id:'video.demo.generate',name:'Demo video',type:'video',operation:'generate',plugin_id:'demo-video',plugin_version:'1.0.0',model_name:'Demo Video',mode_name:'Generate',inputs:{image:{min:0,max:0},video:{min:0,max:0},audio:{min:0,max:0}},input_roles:{},ui:{fields:[
  {bind:'prompt',component:'textarea',label:'Prompt',label_key:'prompt'},
  {bind:'settings.ratio',component:'select',label:'比例',label_key:'比例',default:'16:9',options:[{value:'16:9',label:'16:9 横屏',label_key:'16:9 横屏'},{value:'9:16',label:'9:16 竖屏',label_key:'9:16 竖屏'}]},
  {bind:'settings.resolution',component:'select',label:'分辨率',label_key:'分辨率',default:'480P',options:[{value:'480P',label:'480P'},{value:'720P',label:'720P'}]},
  {bind:'settings.variant',component:'select',label:'生成档位',label_key:'生成档位',default:'quick_preview',options:[{value:'normal',label:'普通',label_key:'普通'},{value:'quick_preview',label:'快速预览',label_key:'快速预览'}]},
  {bind:'settings.camera',component:'select',label:'运镜',label_key:'运镜',default:'auto',options:[{value:'auto',label:'自动',label_key:'自动'}]},
  {bind:'settings.duration',component:'number',label:'时长',label_key:'时长',default:5}
]}};
const chainedCapability = {id:'image.demo.from_video',name:'Image from video',type:'image',operation:'generate',plugin_id:'demo-video',plugin_version:'1.0.0',model_name:'Demo Video',mode_name:'Frame',inputs:{image:{min:0,max:0},video:{min:1,max:1},audio:{min:0,max:0}},input_roles:{video:['reference']},ui:{fields:[]}};
const resourceAction = {id:'demo-video.enhance',name:'Enhance',scope:'resource',automation:true,plugin_id:'demo-video',plugin_version:'1.0.0',input_schema:{type:'object',properties:{strength:{type:'number',title:'Strength'}},additionalProperties:false}};
const dimensionsAction = {id:'demo-video.refine',name:'HD refine',scope:'resource',automation:true,plugin_id:'demo-video',plugin_version:'1.0.0',capability_id:'video.demo.generate',input_schema:{type:'object',properties:{width:{type:'integer',minimum:64},height:{type:'integer',minimum:64}},required:['width','height'],additionalProperties:false},ui:{version:1,fields:[{bind:'target_size',component:'dimensions',label:'Target resolution',alignment:32,presets:[{edge:720,label:'720P'},{edge:768,label:'768P'}],required:true}]}};
const canvasNode = {type:'tools.echo',id:'echo',plugin_id:'tools',plugin_name:'Canvas tools',plugin_version:'1.0.0',name:'Echo',description:'Pass a value',inputs:[{id:'in',name:'Input',type:'text'}],outputs:[{id:'out',name:'Output',type:'text'}],config_schema:{type:'object',properties:{},additionalProperties:false}};
const html = `<!doctype html><html><body style="margin:0;height:800px;background:#111"><div id="app" style="height:800px"></div><script type="module">
import {createApp} from '/vue.js'; import Canvas from '/plugin.js';
window.calls=[];window.agentRuns=0;window.conditionRuns=0;window.conditionValues=[];window.fetch=async (url,options={})=>{const path=String(url),body=options.body instanceof FormData?{form:true}:options.body?JSON.parse(options.body):null;window.calls.push({path,body});let value;
if(path.includes('/capabilities?operation=generate'))value={items:[${JSON.stringify(capability)},${JSON.stringify(chainedCapability)}]};
else if(path.includes('/capabilities?operation=postprocess'))value={items:[]};
else if(path.includes('/plugin-actions?automation=true'))value={items:[${JSON.stringify(resourceAction)},${JSON.stringify(dimensionsAction)},{id:'film.test',name:'Film action',scope:'workspace',automation:true,plugin_id:'film-studio',plugin_version:'1',input_schema:{type:'object',properties:{}}},{id:'progress.test',name:'Progress action',scope:'workspace',automation:true,plugin_id:'ai-project-progress',plugin_version:'1',input_schema:{type:'object',properties:{}}},{id:'workspace.test',name:'Workspace action',scope:'workspace',automation:true,plugin_id:'workspace-tools',plugin_version:'1',input_schema:{type:'object',properties:{}}}]};
else if(path.endsWith('/canvas-nodes'))value={items:[${JSON.stringify(canvasNode)}],errors:[]};
else if(path.endsWith('/plugins'))value={items:[{id:'demo-video',localization:{default_locale:'zh-CN'},ui_messages:{'zh-CN':{},'en-US':{'16:9 横屏':'16:9 landscape','9:16 竖屏':'9:16 portrait','比例':'Aspect ratio','分辨率':'Resolution','生成档位':'Quality preset','运镜':'Camera movement','快速预览':'Quick preview','普通':'Standard','自动':'Auto','时长':'Duration'}}}],applications:[{id:'film-studio'},{id:'infinite-canvas'}],project_tools:[{id:'ai-project-progress'}]};
else if(path.includes('/infinite-canvas.agent-skills/'))value={result:{items:[{id:'general',name:'通用任务',name_en:'General task'},{id:'visual-review',name:'画面质检',name_en:'Visual review'}]}};
else if(path.includes('/infinite-canvas.agent-run/')){window.agentRuns++;value={result:window.agentRuns===1?{decision:'retry',text:'',result:{round:1},score:30,reason:'weak',retry_prompt:'improve it'}:{decision:'pass',text:'',result:{round:2},score:90,reason:'good',retry_prompt:''}};}
else if(path.includes('/infinite-canvas.condition-run/')){window.conditionRuns++;value={result:{value:window.conditionValues.length?window.conditionValues.shift():1}};}
else if(path.includes('/infinite-canvas.list/'))value={result:{items:[]}};
else if(path.endsWith('/generations'))value={job_id:body.capability_id==='video.demo.generate'?'video-job':'image-job'};
else if(path.includes('/jobs/video-job/wait'))value={id:'video-job',kind:'video',status:'completed',request:{params:{latent_width:768,latent_height:432}},artifacts:[{name:'video.mp4',url:'/video.mp4'}]};
else if(path.includes('/jobs/image-job/wait'))value={id:'image-job',kind:'image',status:'completed',artifacts:[{name:'image.png',url:'/image.png'}]};
else if(path.endsWith('/video.mp4'))return new Response(new Blob(['video']),{status:200,headers:{'Content-Type':'video/mp4'}});
else if(path.endsWith('/uploads'))value={upload_id:'0123456789abcdef0123456789abcdef'};
else if(path.includes('/infinite-canvas.import-asset/execute'))value={result:{project_id:'project-test',path:'imports/loaded.png',name:'loaded.png',type:'image',url:'/loaded.png'}};
else if(path.includes('/infinite-canvas.save/execute'))value={result:{revision:1}};
else if(path.includes('/demo-video.enhance/execute'))value={action_id:'demo-video.enhance',status:'accepted',job_id:'enhance-job'};
else if(path.includes('/demo-video.refine/execute'))value={action_id:'demo-video.refine',status:'accepted',job_id:'refine-job'};
else if(path.includes('/jobs/enhance-job/wait')){await new Promise(resolve=>setTimeout(resolve,250));value={id:'enhance-job',kind:'video',status:'completed',artifacts:[{name:'enhanced.mp4',url:'/enhanced.mp4'}]};}
else if(path.includes('/jobs/refine-job/wait'))value={id:'refine-job',kind:'video',status:'completed',artifacts:[{name:'refined.mp4',url:'/refined.mp4'}]};
else if(path.includes('/canvas-nodes/tools.echo/execute'))value={out:'ok'};
else value={result:{items:[]}};
return new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}})};
createApp(Canvas,{project:{id:'project-test'},categoryId:null,locale:'en-US',t:(key,fallback)=>fallback}).mount('#app');
</script></body></html>`;
const server=http.createServer((req,res)=>{const file=req.url.startsWith('/vue.js')?vue:req.url.startsWith('/plugin.js')?plugin:null;if(file){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(file));}else{res.setHeader('Content-Type','text/html');res.end(html);}});

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const executablePath=fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')?'C:/Program Files/Google/Chrome/Application/chrome.exe':'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser=await chromium.launch({headless:true,executablePath});
  try{
    const page=await browser.newPage({viewport:{width:1360,height:800}});
    await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('.ic-node-group .ic-group-head').first().waitFor();
    await page.getByTitle('Run').click();
    await page.locator('.ic-status').filter({hasText:'Add at least one node before running'}).waitFor();
    assert(await page.locator('.ic-status').evaluate(item=>item.classList.contains('is-pulsing')),'an invalid run should provide visible status feedback');
    assert.equal(await page.locator('.ic-validation.is-visible').count(),1,'run validation should open a prominent issue panel');
    await page.locator('.ic-validation header button').click();
    assert.equal(await page.locator('.ic-node-group.is-collapsed').count(),8,'built-in categories and plugin groups should start collapsed');
    assert.equal(await page.locator('.ic-basic-list').count(),5,'built-in nodes should be organized into useful subcategories');
    for(const group of await page.locator('.ic-node-group').all())await group.locator('.ic-group-head').click();
    assert.equal(await page.locator('.ic-node-group.is-collapsed').count(),0,'plugin group headers should toggle open');
    assert.equal(await page.locator('.ic-library-node').count(),19,'basic, agent, condition, count control, generation, post-processing, and canvas-only nodes should be visible');
    assert.equal(await page.locator('.ic-workflow-tab').count(),1,'the initial workflow should be a browser draft tab');
    assert.equal(await page.locator('.ic-workflow-add').count(),1,'a ComfyUI-style plus button should create workflows');
    await page.locator('.ic-workflow-add').click();assert.equal(await page.locator('.ic-workflow-tab').count(),2,'plus should create another browser draft without a save dialog');
    await page.locator('.ic-workflow-tab').first().click();
    assert.equal(await page.getByText('Film action').count(),0,'application plugin actions must be excluded');
    assert.equal(await page.getByText('Progress action').count(),0,'project-tool actions must be excluded');
    assert.equal(await page.getByText('Workspace action').count(),0,'generic workspace actions must be excluded');
    for(const name of ['Demo video','Enhance','Image from video','Echo','Video preview','Text input','HD refine'])await page.locator('.ic-library-node').filter({has:page.getByText(name,{exact:true})}).evaluate(item=>item.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));
    const nodes=page.locator('.ic-node');assert.equal(await nodes.count(),7);
    const refineNode=nodes.nth(6),refineSelect=refineNode.locator('.ic-node-form select');
    assert.equal(await refineSelect.count(),1,'a dimensions action must render one resolution selector');
    assert.equal(await refineSelect.locator('option').first().textContent(),'720P','the first declared resolution preset must be the canvas default');
    assert.equal(await refineNode.locator('.ic-node-form input[type="number"]').count(),0,'a dimensions action must not expose raw width and height fields');
    const selects=nodes.nth(0).locator('.ic-node-form select');assert.equal(await selects.count(),4,'all registered select settings should be visible in the node');
    assert.equal(await selects.nth(0).locator('option').nth(0).textContent(),'16:9 landscape','option labels should use the owning plugin locale pack');
    assert.equal(await selects.nth(2).inputValue(),'quick_preview','the selected option should retain its stable plugin value');
    const prompt=nodes.nth(0).locator('.ic-node-form textarea').first();await prompt.fill('interactive test prompt');
    assert.equal(await prompt.inputValue(),'interactive test prompt','text inputs should remain mounted and editable after pointerdown');
    await selects.nth(0).click();
    await selects.nth(0).selectOption('9:16');
    assert.equal(await selects.nth(0).inputValue(),'9:16','select controls should accept user input');
    assert.equal(await selects.nth(0).evaluate(item=>getComputedStyle(item).colorScheme),'dark','native controls should follow the dark canvas theme');
    const zoom=page.locator('.ic-zoom input');await zoom.fill('125');await zoom.press('Enter');assert.equal(await zoom.inputValue(),'125','zoom percentage should be directly editable');
    assert((await page.locator('.ic-world').getAttribute('style')).includes('scale(1.25)'),'manual zoom should update the canvas transform');
    await zoom.fill('100');await zoom.press('Enter');
    const layout=await nodes.nth(0).evaluate(node=>{const controls=[...node.querySelectorAll('.ic-node-form select')].map(item=>{const rect=item.getBoundingClientRect();return {top:rect.top,bottom:rect.bottom,visible:!!(rect.width&&rect.height)};});const more=node.querySelector('.ic-more')?.getBoundingClientRect();return {overflow:getComputedStyle(node).overflow,controls,more:more&&{top:more.top,bottom:more.bottom}};});
    assert.equal(layout.overflow,'visible','node content must not clip controls or native menus');
    assert(layout.controls.every(item=>item.visible),'all registered settings should remain visible');
    assert.equal(await page.locator('.ic-more').count(),0,'node parameters must remain fully expanded');
    assert.equal(await page.getByTitle('View details').count(),0,'the node details menu must not be rendered');
    const formGap=await nodes.nth(0).evaluate(node=>Math.round(node.getBoundingClientRect().bottom-node.querySelector('.ic-node-form').getBoundingClientRect().bottom));
    assert(formGap<=2,'node cards must not reserve blank space below their visible fields');
    await page.getByTitle('Run').click();
    assert(await nodes.nth(1).evaluate(node=>node.classList.contains('is-invalid')),'a node with missing required input should be marked invalid');
    assert.equal(await page.locator('.ic-validation-list button').count()>0,true,'all validation failures should be listed');
    await page.locator('.ic-validation header button').click();
    const textNode=page.locator('.ic-node').filter({hasText:'Text input'});await textNode.locator('textarea').fill('prompt from basic node');await textNode.locator('textarea').dispatchEvent('change');
    await textNode.locator('.is-output').click();
    const incompatible=nodes.nth(2).locator('.is-input').first();
    assert(await incompatible.evaluate(item=>item.classList.contains('is-incompatible')),'incompatible ports should be marked while connecting');
    await incompatible.click();
    assert.equal(await page.locator('.ic-wires path').count(),0,'an incompatible connection must be rejected');
    await page.locator('.ic-status').filter({hasText:'cannot feed'}).waitFor();
    await textNode.locator('.is-output').click();await nodes.nth(0).locator('.is-input').first().click();
    await nodes.nth(0).locator('.is-output').first().click();await nodes.nth(1).locator('.is-input').first().click();
    await nodes.nth(0).locator('.is-output').nth(2).click();await nodes.nth(2).locator('.is-input').first().click();
    await nodes.nth(0).locator('.is-output').nth(2).click();await nodes.nth(4).locator('.is-input').first().click();
    await nodes.nth(0).locator('.is-output').first().click();await refineNode.locator('.is-input').first().click();
    assert.equal(await page.locator('.ic-wires path').count(),5,'real pointer clicks should create prompt, graph, preview, and post-process connections');
    await nodes.nth(0).evaluate(node=>node.dataset.dragIdentity='stable');
    const header=nodes.nth(0).locator('.ic-node-head'),headBox=await header.boundingBox();
    await page.mouse.move(headBox.x+30,headBox.y+20);await page.mouse.down();await page.mouse.move(headBox.x+90,headBox.y+70,{steps:8});await page.mouse.up();
    assert.equal(await nodes.nth(0).getAttribute('data-drag-identity'),'stable','dragging must preserve the node DOM instead of rebuilding it on every frame');
    await page.locator('.ic-library-node').filter({has:page.getByText('Echo',{exact:true})}).evaluate(item=>item.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));
    const echoNodes=page.locator('.ic-node').filter({hasText:'Echo'});assert.equal(await echoNodes.count(),2);
    await page.getByTitle('Fit canvas').click();
    const output=echoNodes.nth(0).locator('.is-output'),input=echoNodes.nth(1).locator('.is-input').first();
    const from=await output.boundingBox(),to=await input.boundingBox();
    await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();
    await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:8});
    assert.equal(await page.locator('.ic-wire-preview').count(),1,'dragging from an output should render a live connection preview');
    await page.mouse.up();
    assert.equal(await page.locator('.ic-wires path').count(),6,'dragging output to input should create a graph connection');
    await page.getByTitle('Run').click();const previewNode=page.locator('.ic-node').filter({hasText:'Video preview'});await previewNode.locator('.ic-output-preview video').waitFor();assert(!(await page.locator('.ic-status').textContent()).includes('Workflow run completed'),'a preview must update as soon as its producer completes, before unrelated downstream work finishes');try{await page.locator('.ic-status').filter({hasText:'Workflow run completed'}).waitFor({timeout:5000});}catch(error){console.error('status:',await page.locator('.ic-status').textContent());console.error('nodes:',await page.locator('.ic-node').evaluateAll(items=>items.map(item=>item.className)));throw error;}
    assert.equal(await page.locator('.ic-node.is-completed').count(),8);
    assert.equal(await page.locator('.ic-node-state').count(),0,'completed nodes must not show a redundant check icon');
    assert.equal(await previewNode.locator('.ic-output-preview video').getAttribute('src'),'/video.mp4');
    const captured=await page.evaluate(()=>window.calls),generation=captured.find(item=>item.path.endsWith('/generations'));
    assert.equal(generation.body.prompt_processing,'direct');
    assert.equal(generation.body.prompt,'prompt from basic node','a connected text input must supply the generation prompt');
    assert.equal(generation.body.settings.ratio,'9:16','submitted data must use the stable plugin value, not the translated label');
    const actionCall=captured.find(item=>item.path.includes('/demo-video.enhance/execute'));assert.equal(actionCall.body.source_job_id,'video-job');
    const refineCall=captured.find(item=>item.path.includes('/demo-video.refine/execute'));assert.equal(refineCall.body.source_job_id,'video-job');assert.equal(refineCall.body.inputs.width,1312);assert.equal(refineCall.body.inputs.height,736);
    const chained=captured.find(item=>item.path.endsWith('/generations')&&item.body.capability_id==='image.demo.from_video');assert.equal(chained.body.inputs[0].upload_id,'0123456789abcdef0123456789abcdef');
    assert(captured.some(item=>item.path.includes('/canvas-nodes/tools.echo/execute')));
    await page.locator('.ic-library-node').filter({hasText:'Load image'}).evaluate(item=>item.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));
    const loader=page.locator('.ic-node').filter({hasText:'Load image'}),chooser=page.waitForEvent('filechooser');await loader.getByRole('button',{name:'Choose file'}).click();const fileChooser=await chooser;await fileChooser.setFiles({name:'loaded.png',mimeType:'image/png',buffer:Buffer.from('png')});await loader.locator('img').waitFor();assert.equal(await loader.locator('img').getAttribute('src'),'/loaded.png','a local loader node should persist and preview its selected file');
    const draftKey=await page.evaluate(()=>Object.keys(localStorage).find(key=>key.startsWith('videofree.infinite-canvas.drafts.')));assert(draftKey,'browser drafts should be persisted locally');
    await page.locator('.ic-library-node').filter({has:page.getByText('Agent',{exact:true})}).evaluate(item=>item.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));
    const agent=page.locator('.ic-node').filter({hasText:'Agent'});assert.equal(await agent.locator('input').count(),0,'system LLM mode must hide all custom API and internal tuning fields');assert.equal(await agent.getByText('Temperature').count(),0);assert.equal(await agent.getByText('Max tokens').count(),0);assert.equal(await agent.getByText('Timeout').count(),0);await agent.locator('select').nth(1).selectOption('custom');const agentInputs=agent.locator('.ic-node-form input');await agentInputs.nth(0).fill('https://llm.example/v1');await agentInputs.nth(0).dispatchEvent('change');await agent.locator('input[type="password"]').fill('plain-workflow-key');await agent.locator('input[type="password"]').dispatchEvent('change');
    const storedKey=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).flatMap(item=>item.workflow.nodes).find(node=>node.type==='videofree.agent.generic')?.config?.api_key,draftKey);assert.equal(storedKey,'plain-workflow-key','the user-requested custom API key must persist in the workflow JSON');
    await page.getByTitle('Save').click();await page.locator('.ic-dialog-input').fill('Browser workflow');await page.locator('.ic-dialog-actions button[type="submit"]').click();await page.locator('.ic-status').filter({hasText:'Saved revision 1'}).waitFor();
    await page.locator('.ic-workflow-add').click();
    for(const name of ['Text input','Text input','Demo video','LLM condition','Video preview'])await page.locator('.ic-library-node').filter({has:page.getByText(name,{exact:true})}).evaluate(item=>item.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));
    const loopTexts=page.locator('.ic-node').filter({hasText:'Text input'}),loopDemo=page.locator('.ic-node').filter({hasText:'Demo video'}),condition=page.locator('.ic-node').filter({hasText:'LLM condition'}),loopPreview=page.locator('.ic-node').filter({hasText:'Video preview'});
    await loopTexts.nth(0).locator('textarea').fill('video prompt');await loopTexts.nth(0).locator('textarea').dispatchEvent('change');
    await loopTexts.nth(1).locator('textarea').fill('quality report');await loopTexts.nth(1).locator('textarea').dispatchEvent('change');
    await condition.locator('textarea').fill('Return success only when the quality report passes');await condition.locator('textarea').dispatchEvent('change');
    await loopTexts.nth(0).locator('.is-output').click();await loopDemo.locator('.is-input').first().click();
    await loopDemo.locator('.is-output').nth(2).click();await condition.locator('.is-input').nth(0).click();
    await loopTexts.nth(1).locator('.is-output').click();await condition.locator('.is-input').nth(1).click();
    await condition.locator('.is-output').nth(0).click();await loopPreview.locator('.is-input').first().click();
    await condition.locator('.is-output').nth(1).click();await loopDemo.locator('.is-input').last().click();
    assert.equal(await page.locator('.ic-wires path.is-loop').count(),1,'failure must create one explicit loop edge');
    await page.evaluate(()=>{window.conditionRuns=0;window.conditionValues=[0,1];});
    const generationsBefore=await page.evaluate(()=>window.calls.filter(item=>item.path.endsWith('/generations')).length);await page.getByTitle('Run').click();try{await page.locator('.ic-status').filter({hasText:'Workflow run completed'}).waitFor({timeout:5000});}catch(error){console.error('condition status:',await page.locator('.ic-status').textContent());console.error('condition validation:',await page.locator('.ic-validation').textContent());throw error;}
    assert.equal(await page.evaluate(()=>window.conditionRuns),2,'the condition must be evaluated again after one retry');
    assert.equal((await page.evaluate(()=>window.calls.filter(item=>item.path.endsWith('/generations')).length))-generationsBefore,2,'the retry target must run once initially and once after failure');
    assert.equal(await loopPreview.locator('.ic-output-preview video').getAttribute('src'),'/video.mp4','success must pass the original video payload through unchanged');
    await page.evaluate(()=>{window.conditionRuns=0;window.conditionValues=Array(100).fill(0);});await page.getByTitle('Run').click();await page.waitForFunction(()=>window.conditionRuns>=3);await page.getByTitle('Stop').click();await page.locator('.ic-status').filter({hasText:'Run stopped'}).waitFor({timeout:5000});assert((await page.evaluate(()=>window.conditionRuns))<100,'an unlimited loop must yield to the stop control');

    await page.locator('.ic-workflow-add').click();
    for(const name of ['Text input','Text input','Demo video','LLM condition','Count control','Video preview'])await page.locator('.ic-library-node').filter({has:page.getByText(name,{exact:true})}).evaluate(item=>item.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));
    const limitedTexts=page.locator('.ic-node').filter({hasText:'Text input'}),limitedDemo=page.locator('.ic-node').filter({hasText:'Demo video'}),limitedCondition=page.locator('.ic-node').filter({hasText:'LLM condition'}),counter=page.locator('.ic-node').filter({hasText:'Count control'}),limitedPreview=page.locator('.ic-node').filter({hasText:'Video preview'});
    await limitedTexts.nth(0).locator('textarea').fill('video prompt');await limitedTexts.nth(0).locator('textarea').dispatchEvent('change');await limitedTexts.nth(1).locator('textarea').fill('always fail');await limitedTexts.nth(1).locator('textarea').dispatchEvent('change');await limitedCondition.locator('textarea').fill('Always fail this test');await limitedCondition.locator('textarea').dispatchEvent('change');await counter.locator('input[type="number"]').fill('2');await counter.locator('input[type="number"]').dispatchEvent('change');
    await limitedTexts.nth(0).locator('.is-output').click();await limitedDemo.locator('.is-input').first().click();await limitedDemo.locator('.is-output').nth(2).click();await limitedCondition.locator('.is-input').nth(0).click();await limitedTexts.nth(1).locator('.is-output').click();await limitedCondition.locator('.is-input').nth(1).click();
    await limitedCondition.locator('.is-output').nth(1).click();await counter.locator('.is-input').first().click();await counter.locator('.is-output').nth(0).click();await limitedDemo.locator('.is-input').last().click();await limitedDemo.locator('.is-output').nth(2).click();await limitedPreview.locator('.is-input').first().click();await counter.locator('.is-output').nth(1).click();await limitedPreview.locator('.is-input').last().click();
    assert.equal(await page.locator('.ic-wires path.is-control').count(),2,'counter trigger and end must use forward control edges');assert.equal(await page.locator('.ic-wires path.is-loop').count(),1,'counter continue must use one loop edge');
    await page.evaluate(()=>{window.conditionRuns=0;window.conditionValues=[0,0,0];});const limitedGenerations=await page.evaluate(()=>window.calls.filter(item=>item.path.endsWith('/generations')).length);await page.getByTitle('Run').click();try{await page.locator('.ic-status').filter({hasText:'Workflow run completed'}).waitFor({timeout:5000});}catch(error){console.error('limited status:',await page.locator('.ic-status').textContent());console.error('limited validation:',await page.locator('.ic-validation').textContent());throw error;}
    assert.equal(await page.evaluate(()=>window.conditionRuns),3,'two configured retries must run after the initial failed evaluation');assert.equal((await page.evaluate(()=>window.calls.filter(item=>item.path.endsWith('/generations')).length))-limitedGenerations,3,'the retry limit must count reruns rather than the initial execution');assert.equal(await limitedPreview.locator('.ic-output-preview video').getAttribute('src'),'/video.mp4','the end control path must receive the latest upstream media');
    console.log('infinite-canvas browser interactions ok');
  } finally {await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exit(1);});
