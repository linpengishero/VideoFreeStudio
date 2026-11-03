// Dependency-free application component. Vue is owned by the host.
const API = '/api/v2';
const KIND = 'videofree.infinite-canvas';
const PLUGIN_VERSION = '1.5.0';
const ZOOM_MIN = .25, ZOOM_MAX = 2;
const CARD_W = 304, CARD_HEAD = 48, PORT_STEP = 28;

function tx(vm, key, zh, en, values = {}) {
  const fallback = vm.locale === 'en-US' ? en : zh;
  const text = typeof vm.t === 'function' ? vm.t(key, fallback, values) : fallback;
  return String(text).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
}
function uid(prefix) {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '') || Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-${random.slice(0, 16)}`;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function icon(name) {
  const symbols = {add:'+', save:'▣', run:'▶', stop:'■', import:'↥', export:'↧', check:'✓', trash:'⌫', fit:'⌗', search:'⌕', copy:'⧉', close:'×', minus:'−', resource:'◇', file:'⊕'};
  const span = el('span', 'ic-icon', symbols[name] || '·');
  span.setAttribute('aria-hidden', 'true');
  return span;
}
function control(name, title, handler, className = '') {
  const button = el('button', `ic-tool ${className}`.trim());
  button.type = 'button'; button.title = title; button.setAttribute('aria-label', title);
  button.append(icon(name)); button.addEventListener('click', handler);
  return button;
}
function ask(vm, message, title, confirmText) {
  return new Promise(resolve => {
    if (vm._dialogFinish) vm._dialogFinish(false);
    const dialog=el('dialog','ic-dialog'),panel=el('form','ic-dialog-panel');panel.method='dialog';
    panel.append(el('h3','',title),el('p','',message));const actions=el('div','ic-dialog-actions');
    const cancel=el('button','ui-button',tx(vm,'action.cancel','取消','Cancel'));cancel.type='button';
    const confirmButton=el('button','ui-button is-danger',confirmText);confirmButton.type='button';
    actions.append(cancel,confirmButton);panel.append(actions);dialog.append(panel);document.body.append(dialog);
    let done=false;const finish=value=>{if(done)return;done=true;if(dialog.open)dialog.close();dialog.remove();vm._dialogFinish=null;resolve(value);};vm._dialogFinish=finish;
    cancel.addEventListener('click',()=>finish(false));confirmButton.addEventListener('click',()=>finish(true));
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});dialog.addEventListener('click',event=>{if(event.target===dialog)finish(false);});dialog.showModal();
  });
}
function promptName(vm, value='') {
  return new Promise(resolve=>{
    if(vm._dialogFinish)vm._dialogFinish(null);
    const dialog=el('dialog','ic-dialog'),panel=el('form','ic-dialog-panel');panel.method='dialog';panel.append(el('h3','',tx(vm,'workflow.save_title','保存工作流','Save workflow')),el('p','',tx(vm,'workflow.save_hint','输入工作流名称后保存到当前项目。','Name this workflow before saving it to the project.')));
    const input=el('input','ic-dialog-input');input.maxLength=120;input.value=value;input.placeholder=tx(vm,'workflow.name','工作流名称','Workflow name');panel.append(input);const actions=el('div','ic-dialog-actions'),cancel=el('button','ui-button',tx(vm,'action.cancel','取消','Cancel')),save=el('button','ui-button is-primary',tx(vm,'action.save.short','保存','Save'));cancel.type='button';save.type='submit';actions.append(cancel,save);panel.append(actions);dialog.append(panel);document.body.append(dialog);
    let done=false;const finish=result=>{if(done)return;done=true;if(dialog.open)dialog.close();dialog.remove();vm._dialogFinish=null;resolve(result);};vm._dialogFinish=finish;cancel.addEventListener('click',()=>finish(null));panel.addEventListener('submit',event=>{event.preventDefault();const name=input.value.trim();if(!name){input.classList.add('is-error');input.focus();return;}finish(name);});dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null);});dialog.showModal();queueMicrotask(()=>{input.focus();input.select();});
  });
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function workflowFileProblem(workflow) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return 'root';
  if (workflow.schema_version !== 1 || workflow.kind !== KIND || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) return 'format';
  if (workflow.nodes.length > 500 || workflow.edges.length > 2000) return 'limit';
  const nodeIds = new Set();
  for (const node of workflow.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node.id !== 'string' || !node.id || typeof node.type !== 'string' || !node.type || nodeIds.has(node.id)) return 'node';
    if (!node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) return 'node';
    if (node.config != null && (typeof node.config !== 'object' || Array.isArray(node.config))) return 'node';
    if (node.values != null && (typeof node.values !== 'object' || Array.isArray(node.values))) return 'node';
    nodeIds.add(node.id);
  }
  const edgeIds = new Set();
  for (const edge of workflow.edges) {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge) || typeof edge.id !== 'string' || !edge.id || edgeIds.has(edge.id)) return 'edge';
    if (!edge.from || !edge.to || typeof edge.from.node !== 'string' || typeof edge.from.port !== 'string' || typeof edge.to.node !== 'string' || typeof edge.to.port !== 'string') return 'edge';
    if (!nodeIds.has(edge.from.node) || !nodeIds.has(edge.to.node) || !['data','control','loop'].includes(edge.kind || 'data')) return 'edge';
    edgeIds.add(edge.id);
  }
  if (workflow.viewport != null && (!workflow.viewport || typeof workflow.viewport !== 'object' || !Number.isFinite(workflow.viewport.x) || !Number.isFinite(workflow.viewport.y) || !Number.isFinite(workflow.viewport.zoom) || workflow.viewport.zoom < ZOOM_MIN || workflow.viewport.zoom > ZOOM_MAX)) return 'viewport';
  return '';
}
function emptyWorkflow(name) {
  return {schema_version:1, kind:KIND, id:uid('workflow'), name, nodes:[], edges:[], viewport:{x:0,y:0,zoom:1}};
}
function draftKey(projectId) { return `videofree.infinite-canvas.drafts.${projectId||'none'}`; }
function readDrafts(projectId) { try{const value=JSON.parse(localStorage.getItem(draftKey(projectId))||'[]');return Array.isArray(value)?value.filter(item=>item?.workflow?.kind===KIND).slice(-12):[];}catch{return [];} }
function writeDrafts(projectId,drafts) { try{localStorage.setItem(draftKey(projectId),JSON.stringify(drafts.slice(-12)));}catch{} }
function persistDraft(vm) { if(!vm.project?.id||!vm.workflow)return;const entry={workflow:clone(vm.workflow),revision:vm.revision||0,dirty:Boolean(vm.dirty),updated_at:Date.now()},index=vm.browserDrafts.findIndex(item=>item.workflow.id===vm.workflow.id);if(index>=0)vm.browserDrafts[index]=entry;else vm.browserDrafts.push(entry);writeDrafts(vm.project.id,vm.browserDrafts); }
function removeDraft(vm,id) { vm.browserDrafts=vm.browserDrafts.filter(item=>item.workflow.id!==id);writeDrafts(vm.project?.id,vm.browserDrafts); }
async function request(path, options = {}) {
  const response = await fetch(path, {credentials:'same-origin', ...options, headers:{...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {})}});
  let body = null;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) throw new Error(body.detail || body.error || `${response.status} ${response.statusText}`);
  return body;
}
async function uploadFile(file) {
  const form=new FormData();form.append('file',file,file.name||'canvas-media');
  const response=await fetch(`${API}/uploads`,{method:'POST',credentials:'same-origin',body:form});let body={};try{body=await response.json();}catch{}if(!response.ok)throw new Error(body.detail||body.error||`${response.status} ${response.statusText}`);return body;
}
function action(id, projectId, inputs = {}) {
  return request(`${API}/plugin-actions/infinite-canvas.${id}/execute`, {method:'POST', body:JSON.stringify({project_id:projectId, inputs})}).then(value => value.result || value);
}
function optionValue(option) { return option && typeof option === 'object' ? option.value : option; }
function optionLabel(option) { return option && typeof option === 'object' ? option.label ?? option.value : option; }
function catalogTranslator(catalog, locale) {
  const byPlugin = new Map((catalog?.items || []).map(item => [item.id, item]));
  return (pluginId, key, fallback) => {
    if (!key) return fallback;
    const messages = byPlugin.get(pluginId)?.ui_messages || {};
    return messages?.[locale]?.[key] ?? messages?.[byPlugin.get(pluginId)?.localization?.default_locale || 'zh-CN']?.[key] ?? fallback;
  };
}
function localizedOption(option, translate, pluginId) {
  if (!option || typeof option !== 'object') return option;
  return {...option, label:translate(pluginId, option.label_key, option.label ?? option.value)};
}
function schemaType(schema = {}) {
  const type=Array.isArray(schema.type)?schema.type.find(item=>item!=='null'):schema.type;
  if(type==='integer'||type==='number'||type==='boolean')return type;
  if(type==='string'&&schema.format==='upload')return 'upload';
  return type==='string'?'text':'json';
}
function fieldSchema(field, translate = (pluginId, key, fallback) => fallback, pluginId = '') {
  const values=(field.options||[]).map(optionValue), sample=values.find(value=>value!=null);
  let type=field.component==='number'?(Number.isInteger(field.step)&&field.step>=1?'integer':'number'):'string';
  if(values.length)type=typeof sample==='number'?(Number.isInteger(sample)?'integer':'number'):typeof sample==='boolean'?'boolean':'string';
  const schema={type,title:translate(pluginId, field.label_key, field.label||field.bind)};
  if(values.length)schema.enum=values;
  if(field.minimum!=null)schema.minimum=field.minimum;
  if(field.maximum!=null)schema.maximum=field.maximum;
  if(field.default!==undefined)schema.default=field.default;
  // Keep plugin-owned presentation labels alongside the JSON Schema enum values.
  // The value sent to the gateway remains the stable option value.
  if((field.options||[]).some(option=>option&&typeof option==='object'))schema.options=field.options.map(option=>localizedOption(option, translate, pluginId));
  return schema;
}
function dimensionChoice(index) { return String(index); }
function dimensionsSchema(field, translate, pluginId) {
  const options=(field.presets||[]).map((preset,index)=>({
    value:dimensionChoice(index),
    label:translate(pluginId,preset.label_key,preset.label||`${preset.edge}${preset.long_edge?' long':' short'}`),
  }));
  return {type:'string',title:translate(pluginId,field.label_key,field.label||'目标分辨率'),enum:options.map(item=>item.value),options,default:options[0]?.value||'0'};
}
function sourceDimensions(source) {
  const params=source?.request?.params||source?.params||{};
  const width=Number(params.latent_width||params.width||source?.request?.width||source?.width||16);
  const height=Number(params.latent_height||params.height||source?.request?.height||source?.height||9);
  return {width:width>0?width:16,height:height>0?height:9};
}
function fittedDimensions(field, selected, source) {
  const presets=field?.presets||[],index=Math.max(0,Math.min(presets.length-1,Number.parseInt(selected,10)||0)),preset=presets[index];
  if(!preset)throw new Error('This action has no resolution preset');
  const {width,height}=sourceDimensions(source),alignment=Number(field.alignment)||1;
  const scale=Number(preset.edge)/(preset.long_edge?Math.max(width,height):Math.min(width,height));
  const idealWidth=width*scale,idealHeight=height*scale,ratio=width/height;
  let best=null;
  for(let w=Math.max(1,Math.round(idealWidth/alignment)-4);w<=Math.round(idealWidth/alignment)+4;w++){
    for(let h=Math.max(1,Math.round(idealHeight/alignment)-4);h<=Math.round(idealHeight/alignment)+4;h++){
      const targetWidth=w*alignment,targetHeight=h*alignment;
      const score=Math.abs(targetWidth/targetHeight-ratio)/ratio+.125*(Math.abs(targetWidth-idealWidth)/idealWidth+Math.abs(targetHeight-idealHeight)/idealHeight);
      if(!best||score<best.score)best={width:targetWidth,height:targetHeight,score};
    }
  }
  if(!best||best.width<width||best.height<height)throw new Error('Selected resolution cannot be lower than the source');
  return best;
}
function setPath(target, path, value) {
  const parts=String(path).split('.');let cursor=target;
  for(let index=0;index<parts.length-1;index++)cursor=cursor[parts[index]]??=( {} );
  cursor[parts.at(-1)]=value;
}
function standardTaskOutputs(kind,locale,{includeResult=false}={}) {
  const en=locale==='en-US',outputs=[];
  if(includeResult)outputs.push({id:'result',name:en?'Result':'结果',type:'json'});
  outputs.push({id:'job',name:en?'Job':'任务',type:'job',semantic:['generation_job']},{id:'artifacts',name:en?'Artifacts':'产物',type:'artifact',cardinality:'many',semantic:['generated_artifact']});
  if(kind)outputs.push({id:'media',name:en?'Media result':'媒体结果',type:kind,semantic:[`generated_${kind}`]});
  return outputs;
}
function capabilitySpec(item, translate, locale) {
  const en=locale==='en-US',inputs=[],properties={},required=[];
  for(const field of item.ui?.fields||[]){
    if(field.component==='media')continue;
    if(field.bind==='prompt'||field.bind==='lyrics'){
      if(!inputs.some(input=>input.id===field.bind))inputs.push({id:field.bind,name:translate(item.plugin_id, field.label_key, field.label||field.bind),type:'text',accepts:['text'],semantic:[field.bind==='prompt'?'prompt':'lyrics'],required:Boolean(field.required),multiline:field.component==='textarea'});
      continue;
    }
    if(!field.bind)continue;
    properties[field.bind]=fieldSchema(field, translate, item.plugin_id);if(field.required)required.push(field.bind);
  }
  for(const media of ['image','video','audio']){
    const limits=item.inputs?.[media]||{},maximum=Number(limits.max||0);if(maximum<1)continue;
    inputs.push({id:`${media}_inputs`,name:media==='image'?(en?'Reference images':'参考图片'):media==='video'?(en?'Reference videos':'参考视频'):(en?'Reference audio':'参考音频'),type:media,semantic:[`reference_${media}`],required:Number(limits.min||0)>0,multiple:maximum>1,minimum:Number(limits.min||0),maximum});
  }
  const outputType=item.type==='tts'?'audio':item.type;
  inputs.push({id:'flow_control',name:en?'Control':'控制',type:'control',accepts:['control'],accepts_semantic:['control_signal']});
  return {type:`videofree.capability.${item.id}`,id:item.id,source:'capability',executor:'capability',source_group:item._canvas_group||'generation',plugin_id:item.plugin_id,plugin_name:item.model_name||item.plugin_id,plugin_version:item.plugin_version,name:item.name,description:item.mode_name||item.operation,available:item.available!==false,unavailable_reason:item.unavailable_reason||item.availability_reason||'',capability_id:item.id,input_roles:item.input_roles||{},inputs,outputs:standardTaskOutputs(outputType,locale),config_schema:{type:'object',properties,required,additionalProperties:false}};
}
function actionSpec(item, translate, capabilitiesById, locale) {
  const en=locale==='en-US',inputs=[];
  if(item.scope==='resource')inputs.push({id:'source_job',name:en?'Source job':'来源任务',type:'job',accepts:['job'],accepts_semantic:['generation_job','action_job'],semantic:['source_job'],required:true});
  const schema=item.input_schema||{type:'object',properties:{}};
  const fields=new Map((item.ui?.fields||[]).map(field=>[field.bind,field]));
  const dimensionField=(item.ui?.fields||[]).find(field=>field.component==='dimensions'&&field.bind==='target_size');
  for(const [id,value] of Object.entries(schema.properties||{})){if(dimensionField&&['width','height'].includes(id))continue;const field=fields.get(id),options=field?.options||value.enum;inputs.push({id,name:translate(item.plugin_id,field?.label_key,field?.label||value.title||id),type:schemaType(value),required:(schema.required||[]).includes(id),multiple:value.type==='array',options:options?.map(option=>localizedOption(option,translate,item.plugin_id)),default:field?.default??value.default});}
  const outputKind=capabilitiesById.get(item.capability_id)?.type;
  const outputs=standardTaskOutputs(outputKind?(outputKind==='tts'?'audio':outputKind):'',locale,{includeResult:true});
  const jobOutput=outputs.find(output=>output.id==='job');if(jobOutput)jobOutput.semantic=['action_job'];
  const configProperties=dimensionField?{target_size:dimensionsSchema(dimensionField,translate,item.plugin_id)}:{};
  inputs.push({id:'flow_control',name:en?'Control':'控制',type:'control',accepts:['control'],accepts_semantic:['control_signal']});
  return {type:`videofree.action.${item.id}`,id:item.id,source:'action',executor:'action',source_group:'postprocess',plugin_id:item.plugin_id,plugin_name:item.plugin_id,plugin_version:item.plugin_version,name:item.name,description:en?'Resource processing action':'资源处理动作',available:item.available!==false,unavailable_reason:item.unavailable_reason||item.availability_reason||'',action_id:item.id,action_scope:item.scope,dimension_field:dimensionField||null,inputs,outputs,config_schema:{type:'object',properties:configProperties,required:dimensionField?['target_size']:[],additionalProperties:false}};
}
function canvasSpec(item,locale) {
  const inputs=[...(item.inputs||[])];if(!inputs.some(input=>input.id==='flow_control'))inputs.push({id:'flow_control',name:locale==='en-US'?'Control':'控制',type:'control',accepts:['control'],accepts_semantic:['control_signal']});
  return {...item,type:`canvas.${item.type}`,node_type:item.type,source:'canvas',executor:'canvas',source_group:'canvas',inputs};
}
function resourceSpec(kind,locale) {
  const names={image:['项目图片','Project image'],video:['项目视频','Project video'],audio:['项目音频','Project audio'],music:['项目音乐','Project music']},label=names[kind]||names.image;
  const en=locale==='en-US';return {type:`videofree.resource.${kind}`,id:`resource.${kind}`,source:'resource',executor:'resource',source_group:'basic',library_category:'media',hidden:true,plugin_id:'infinite-canvas',plugin_name:'Infinite Canvas',plugin_version:PLUGIN_VERSION,name:en?label[1]:label[0],description:en?'Project media input':'项目资源输入',inputs:[],outputs:[{id:'media',name:en?'Media':'资源',type:kind==='music'?'audio':kind,semantic:['project_asset',`reference_${kind==='music'?'audio':kind}`]}],config_schema:{type:'object',properties:{},additionalProperties:false}};
}
function basicSpecs(locale) {
  const en=locale==='en-US',base={source:'basic',executor:'basic',source_group:'basic',library_category:'input',plugin_id:'infinite-canvas',plugin_name:'Infinite Canvas',plugin_version:PLUGIN_VERSION,inputs:[]};
  return [
    {...base,type:'videofree.input.text',id:'input.text',name:en?'Text input':'文本输入',description:en?'Enter a prompt or other text':'输入提示词或其他文本',outputs:[{id:'value',name:en?'Text':'文本',type:'text',semantic:['text','prompt']}],config_schema:{type:'object',properties:{value:{type:'string',title:en?'Text':'文本',multiline:true}},required:['value'],additionalProperties:false}},
    {...base,type:'videofree.input.number',id:'input.number',name:en?'Number input':'数字输入',description:en?'Enter a numeric value':'输入数字参数',outputs:[{id:'value',name:en?'Number':'数字',type:'number'}],config_schema:{type:'object',properties:{value:{type:'number',title:en?'Number':'数字',default:0}},required:['value'],additionalProperties:false}},
    {...base,type:'videofree.input.boolean',id:'input.boolean',name:en?'Boolean input':'开关输入',description:en?'Provide an on/off value':'输入开启或关闭值',outputs:[{id:'value',name:en?'Boolean':'开关',type:'boolean'}],config_schema:{type:'object',properties:{value:{type:'boolean',title:en?'Enabled':'启用',default:false}},required:['value'],additionalProperties:false}},
    {...base,type:'videofree.input.json',id:'input.json',name:'JSON '+(en?'input':'输入'),description:en?'Enter structured JSON data':'输入结构化 JSON 数据',outputs:[{id:'value',name:'JSON',type:'json'}],config_schema:{type:'object',properties:{value:{type:['object','array','string','number','boolean','null'],title:'JSON',default:{}}},required:['value'],additionalProperties:false}},
  ];
}
function loaderSpecs(locale) {
  const en=locale==='en-US',base={source:'resource',executor:'resource',source_group:'basic',library_category:'media',plugin_id:'infinite-canvas',plugin_version:PLUGIN_VERSION,inputs:[],config_schema:{type:'object',properties:{},additionalProperties:false}};
  return [
    {...base,type:'videofree.loader.image',id:'loader.image',name:en?'Load image':'加载图片',description:en?'Choose an image from this computer':'从电脑选择并加载图片',loader_kind:'image',outputs:[{id:'media',name:en?'Image':'图片',type:'image',semantic:['project_asset','reference_image']}]},
    {...base,type:'videofree.loader.video',id:'loader.video',name:en?'Load video':'加载视频',description:en?'Choose a video from this computer':'从电脑选择并加载视频',loader_kind:'video',outputs:[{id:'media',name:en?'Video':'视频',type:'video',semantic:['project_asset','reference_video']}]},
    {...base,type:'videofree.loader.audio',id:'loader.audio',name:en?'Load audio':'加载音频',description:en?'Choose audio from this computer':'从电脑选择并加载音频',loader_kind:'audio',outputs:[{id:'media',name:en?'Audio':'音频',type:'audio',semantic:['project_asset','reference_audio']}]},
  ];
}
function previewSpecs(locale) {
  const en = locale === 'en-US';
  const preview = (kind, zhName, enName, zhDescription, enDescription) => ({
    type:`videofree.preview.${kind}`,id:`preview.${kind}`,source:'preview',executor:'preview',source_group:'basic',library_category:'output',
    plugin_id:'infinite-canvas',plugin_name:'Infinite Canvas',plugin_version:PLUGIN_VERSION,
    name:en?enName:zhName,description:en?enDescription:zhDescription,preview_kind:kind,
    inputs:[{id:'media',name:en?'Result':'结果',type:kind,accepts:kind==='audio'?['audio','music','media','asset']:[kind,'media','asset'],required:true},{id:'flow_control',name:en?'Control':'控制',type:'control',accepts:['control'],accepts_semantic:['control_signal']}],
    outputs:[{id:'media',name:en?'Result':'结果',type:kind}],config_schema:{type:'object',properties:{},additionalProperties:false},
  });
  return [
    preview('image','图片预览','Image preview','查看图片生成结果','Display image results'),
    preview('video','视频预览','Video preview','播放视频生成结果','Play video results'),
    preview('audio','声音预览','Audio preview','试听语音或音乐结果','Play speech or music results'),
    {type:'videofree.preview.data',id:'preview.data',source:'preview',executor:'preview',source_group:'basic',library_category:'output',plugin_id:'infinite-canvas',plugin_name:'Infinite Canvas',plugin_version:PLUGIN_VERSION,name:en?'Data preview':'数据预览',description:en?'Inspect text, JSON, job, or artifact data':'查看文本、JSON、任务或产物数据',preview_kind:'data',inputs:[{id:'data',name:en?'Data':'数据',type:'json',accepts:['text','json','job','artifact'],required:true},{id:'flow_control',name:en?'Control':'控制',type:'control',accepts:['control'],accepts_semantic:['control_signal']}],outputs:[{id:'data',name:en?'Data':'数据',type:'json'}],config_schema:{type:'object',properties:{},additionalProperties:false}},
  ];
}
function agentSpec(skills,locale) {
  const en=locale==='en-US',skillOptions=(skills||[]).map(item=>({value:item.id,label:en?item.name_en:item.name}));
  return {type:'videofree.agent.generic',id:'agent.generic',source:'agent',executor:'agent',source_group:'intelligent',library_category:'agent',plugin_id:'infinite-canvas',plugin_name:'Infinite Canvas',plugin_version:PLUGIN_VERSION,name:en?'Agent':'智能体',description:en?'Run a task with a selected skill and role':'通过所选技能与系统角色执行智能任务',inputs:[
    {id:'media',name:en?'Media':'媒体',type:'media',accepts:['image','video','audio','music','media','asset'],multiple:true},
    {id:'flow_control',name:en?'Control':'控制',type:'control',accepts:['control'],accepts_semantic:['control_signal']},
  ],outputs:[
    {id:'text',name:en?'Text':'文本',type:'text'},
    {id:'result',name:en?'Result':'结果',type:'json'},
  ],config_schema:{type:'object',properties:{
    skill_id:{type:'string',title:en?'Skill':'技能',enum:skillOptions.map(item=>item.value),options:skillOptions,default:skillOptions[0]?.value||'general'},
    task_prompt:{type:'string',title:en?'Role and task':'角色与任务',multiline:true,default:''},
    llm_source:{type:'string',title:en?'LLM source':'LLM 来源',enum:['system','custom'],options:[{value:'system',label:en?'System LLM':'系统 LLM'},{value:'custom',label:en?'Custom API':'自定义 API'}],default:'system'},
    api_url:{type:'string',title:'API URL',default:'',visible_if:{llm_source:'custom'}},api_key:{type:'string',format:'password',title:'API Key',default:'',visible_if:{llm_source:'custom'}},model:{type:'string',title:en?'Model':'模型',default:'',visible_if:{llm_source:'custom'}},
  },required:['skill_id','task_prompt','llm_source'],additionalProperties:false}};
}
function conditionSpec(locale) {
  const en=locale==='en-US';return {type:'videofree.control.llm-condition',id:'control.llm-condition',source:'condition',source_group:'basic',library_category:'control',plugin_id:'infinite-canvas',plugin_name:'Infinite Canvas',plugin_version:PLUGIN_VERSION,name:en?'LLM condition':'LLM 条件判断',description:en?'Pass any payload on success or trigger a retry path on failure':'成功时原样传递任意产物，失败时触发重做路径',inputs:[
    {id:'payload',name:en?'Original payload':'原始产物',type:'any',type_var:'T',accepts:['text','number','integer','boolean','json','job','artifact','image','video','audio','music','media','asset'],required:true},
    {id:'text',name:en?'Judgement text':'判断文本',type:'text',accepts:['text'],required:true},
    {id:'flow_control',name:en?'Control':'控制',type:'control',accepts:['control'],accepts_semantic:['control_signal']},
  ],outputs:[
    {id:'success',name:en?'Success':'成功',type:'any',type_var:'T',passthrough_from:'payload',allow_empty:true},
    {id:'failure',name:en?'Failure':'失败',type:'control',semantic:['control_signal'],flow_mode:'retry'},
  ],executor:'condition',executor_config:{action:'condition-run',judgement_input:'text',rule_config:'rule'},flow:{version:1,kind:'retry_decision',payload_input:'payload',success_output:'success',retry_output:'failure'},config_schema:{type:'object',properties:{rule:{type:'string',title:en?'Judgement rule':'判断规则',multiline:true,default:''}},required:['rule'],additionalProperties:false}};
}
function countControlSpec(locale) {
  const en=locale==='en-US';return {type:'videofree.control.count',id:'control.count',source:'counter',executor:'flow',source_group:'basic',library_category:'control',plugin_id:'infinite-canvas',plugin_name:'Infinite Canvas',plugin_version:PLUGIN_VERSION,name:en?'Count control':'次数控制',description:en?'Limit retries using a user-selected count':'按用户设置的次数限制循环重做',inputs:[{id:'trigger',name:en?'Trigger':'触发',type:'control',accepts:['control'],accepts_semantic:['control_signal'],flow_role:'trigger',required:true}],outputs:[{id:'continue',name:en?'Continue':'继续',type:'control',semantic:['control_signal'],flow_mode:'loop'},{id:'end',name:en?'End':'结束',type:'control',semantic:['control_signal'],flow_mode:'forward'}],flow:{version:1,kind:'retry_counter',trigger_input:'trigger',continue_output:'continue',exhausted_output:'end',limit_config:'max_count'},config_schema:{type:'object',properties:{max_count:{type:'integer',title:en?'Maximum retries':'最大循环次数',minimum:1,maximum:1000,default:3}},required:['max_count'],additionalProperties:false}};
}
function installedApplicationIds(catalog) { return new Set([...(catalog?.applications||[]),...(catalog?.project_tools||[])].map(item=>item.id||item.plugin_id).filter(Boolean)); }
function adaptCatalog(generated,postprocessed,actions,canvas,catalog,locale,skills=[]) {
  const excluded=installedApplicationIds(catalog), allowed=item=>item.plugin_id!=='infinite-canvas'&&!excluded.has(item.plugin_id);
  const translate=catalogTranslator(catalog,locale);
  const rawCapabilities=[...(generated?.items||[]).map(item=>({...item,_canvas_group:'generation'})),...(postprocessed?.items||[]).map(item=>({...item,_canvas_group:'postprocess'}))].filter(allowed),capabilitiesById=new Map(rawCapabilities.map(item=>[item.id,item]));
  const capabilities=rawCapabilities.map(item=>capabilitySpec(item,translate,locale));
  const pluginActions=(actions?.items||[]).filter(item=>allowed(item)&&item.scope==='resource').map(item=>actionSpec(item,translate,capabilitiesById,locale));
  return [...['image','video','audio','music'].map(kind=>resourceSpec(kind,locale)),...basicSpecs(locale),...loaderSpecs(locale),conditionSpec(locale),countControlSpec(locale),...previewSpecs(locale),agentSpec(skills,locale),...capabilities,...pluginActions,...(canvas?.items||[]).map(item=>canvasSpec(item,locale))];
}
function asArray(value) { return value==null||value===''?[]:Array.isArray(value)?value:[value]; }
async function uploadIdForMedia(raw) {
  const existing=typeof raw==='string'?raw.replace(/^upload:/,''):raw?.upload_id;
  if(/^[a-fA-F0-9]{32}$/.test(existing||''))return existing;
  if(!raw?.url)throw new Error('Connected media must be a gateway upload or generated artifact');
  const media=await fetch(raw.url,{credentials:'same-origin'});if(!media.ok)throw new Error(`Unable to read connected media (${media.status})`);
  const form=new FormData();form.append('file',await media.blob(),raw.name||'canvas-media');
  const uploaded=await fetch(`${API}/uploads`,{method:'POST',credentials:'same-origin',body:form});let body={};try{body=await uploaded.json();}catch{}if(!uploaded.ok)throw new Error(body.detail||body.error||`Unable to upload connected media (${uploaded.status})`);return body.upload_id;
}
async function mediaInputs(spec, values) {
  const result=[];
  for(const media of ['image','video','audio']){
    const port=spec.inputs.find(item=>item.id===`${media}_inputs`);if(!port)continue;
    const roles=spec.input_roles?.[media]||[];
    for(const [index,raw] of asArray(values[port.id]).flat().entries()){
      const uploadId=await uploadIdForMedia(raw);
      result.push({type:media,upload_id:uploadId,role:raw?.role||roles[index]||roles[0]||'reference'});
    }
  }
  return result;
}
async function waitForJob(jobId) {
  for(;;){const job=await request(`${API}/jobs/${encodeURIComponent(jobId)}/wait?timeout=30`);if(['completed','failed','cancelled'].includes(job.status))return job;}
}
function jobOutputs(job) {
  const artifacts=job?.artifacts||[],kind=job?.kind==='tts'?'audio':job?.kind;
  return {job,artifacts,media:artifacts.length===1?{...artifacts[0],kind}:artifacts.map(item=>({...item,kind}))};
}
function mediaItems(value, fallbackKind = '') {
  const candidates = [];
  const visit = item => {
    if (!item) return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (typeof item !== 'object') return;
    if (item.url || item.artifact_url) candidates.push({...item,url:item.url||item.artifact_url,kind:item.kind||item.type||fallbackKind});
    else if (item.media) visit(item.media);
    else if (item.artifacts) visit(item.artifacts);
  };
  visit(value);
  return candidates;
}
async function executeCapability(vm,spec,values,config) {
  const payload={project_id:vm.project.id,category_id:vm.categoryId||null,capability_id:spec.capability_id,prompt_processing:'direct',prompt:values.prompt||'',lyrics:values.lyrics||'',inputs:await mediaInputs(spec,values),settings:{},parameters:{}};
  for(const [path,value] of Object.entries(config||{}))if(value!==undefined&&value!=='')setPath(payload,path,value);
  const submitted=await request(`${API}/generations`,{method:'POST',body:JSON.stringify(payload)});
  const job=await waitForJob(submitted.job_id);if(job.status!=='completed')throw new Error(job.error||`Job ${job.status}`);return jobOutputs(job);
}
async function executeAction(vm,spec,values,config={}) {
  const source=values.source_job,sourceJobId=typeof source==='string'?source:source?.id||source?.job_id;
  const inputs={...values};delete inputs.source_job;
  if(spec.dimension_field){const fitted=fittedDimensions(spec.dimension_field,config.target_size,source);inputs.width=fitted.width;inputs.height=fitted.height;}
  const submitted=await request(`${API}/plugin-actions/${encodeURIComponent(spec.action_id)}/execute`,{method:'POST',body:JSON.stringify({project_id:vm.project.id,category_id:vm.categoryId||null,source_job_id:sourceJobId||null,source_upload_id:null,inputs})});
  if(!submitted.job_id)return {result:submitted.result??submitted,job:null,artifacts:[]};
  const job=await waitForJob(submitted.job_id);if(job.status!=='completed')throw new Error(job.error||`Job ${job.status}`);return {result:submitted.result??submitted,...jobOutputs(job)};
}
const NODE_EXECUTORS = Object.freeze({
  capability:(vm,node,spec,inputs)=>executeCapability(vm,spec,inputs,node.config||{}),
  action:(vm,node,spec,inputs)=>executeAction(vm,spec,inputs,node.config||{}),
  resource:async (vm,node)=>({media:node.values.asset}),
  basic:async (vm,node,spec)=>({[spec.outputs[0].id]:clone(node.config.value)}),
  preview:async (vm,node,spec,inputs)=>spec.preview_kind==='data'?{data:inputs.data}:{media:inputs.media},
  agent:async (vm,node,spec,inputs)=>{
    const config=node.config||{},custom=config.llm_source==='custom';
    return action('agent-run',vm.project.id,{media:inputs.media,skill_id:config.skill_id||'general',task_prompt:config.task_prompt||'',llm_source:custom?'custom':'system',...(custom?{api_url:config.api_url||'',api_key:config.api_key||'',model:config.model||''}:{})});
  },
  condition:async (vm,node,spec,inputs)=>{
    const config=spec.executor_config||{},flow=flowContract(spec),judged=await action(config.action,vm.project.id,{text:inputs[config.judgement_input],rule:node.config?.[config.rule_config]||''});
    return judged.value===1?{[flow.success_output]:inputs[flow.payload_input]}:{[flow.retry_output]:true};
  },
  flow:async ()=>({}),
  canvas:(vm,node,spec,inputs)=>request(`${API}/canvas-nodes/${encodeURIComponent(spec.node_type)}/execute`,{method:'POST',body:JSON.stringify({project_id:vm.project.id,category_id:vm.categoryId||null,inputs,config:node.config||{}})}),
});
function executorFor(spec) { return NODE_EXECUTORS[spec?.executor]; }
function nodeMap(vm) { return new Map(vm.nodesCatalog.map(item => [item.type, item])); }
function port(node, direction, id, vm, depth=0) {
  const value=nodeMap(vm).get(node.type)?.[direction]?.find(item => item.id === id);
  if(!value?.type_var||direction!=='outputs'||depth>8)return value;
  const passthroughInput=value.passthrough_from;if(!passthroughInput)return value;
  const sourceEdge=incoming(vm,node.id,passthroughInput)[0],sourceNode=sourceEdge&&vm.workflow.nodes.find(item=>item.id===sourceEdge.from.node),sourcePort=sourceNode&&port(sourceNode,'outputs',sourceEdge.from.port,vm,depth+1);
  return sourcePort?{...value,type:sourcePort.type,semantic:sourcePort.semantic}:value;
}
function connectionProblem(output, input) {
  if (!output || !input) return {code:'missing_port'};
  const outputType = String(output.type || '');
  const inputType = String(input.type || '');
  const declaredTypes = Array.isArray(input.accepts) ? input.accepts.filter(type => typeof type === 'string') : null;
  const legacyCompatible = inputType==='any'||outputType === inputType
    || outputType === 'media' && ['image','video','audio','music','media','asset'].includes(inputType)
    || ['asset','media'].includes(inputType) && ['asset','media','image','video','audio','music'].includes(outputType)
    || inputType === 'audio' && outputType === 'music';
  if (declaredTypes ? !declaredTypes.includes(outputType) : !legacyCompatible) return {code:'type',outputType,inputType};
  const acceptedSemantics = Array.isArray(input.accepts_semantic) ? input.accepts_semantic : null;
  if (acceptedSemantics) {
    const outputSemantics = Array.isArray(output.semantic) ? output.semantic : output.semantic ? [output.semantic] : [];
    if (!outputSemantics.some(semantic => acceptedSemantics.includes(semantic))) return {code:'semantic'};
  }
  return null;
}
function compatible(output, input) { return !connectionProblem(output,input); }
function inputCardinality(input) {
  return input.cardinality || (input.multiple ? 'many' : 'one');
}
function edgeKind(edge) { return edge.kind||'data'; }
function incoming(vm, nodeId, portId, kind='data') { return vm.workflow.edges.filter(edge => edge.to.node === nodeId && edge.to.port === portId && edgeKind(edge)===kind); }
function outgoing(vm, nodeId, portId, kind='data') { return vm.workflow.edges.filter(edge => edge.from.node === nodeId && edge.from.port === portId && edgeKind(edge)===kind); }
function flowContract(spec) { return spec?.flow?.version===1?spec.flow:null; }
function nodeContractProblem(spec) {
  if(!spec||!executorFor(spec))return 'executor';
  const inputs=spec.inputs||[],outputs=spec.outputs||[],inputIds=new Set(inputs.map(item=>item.id)),outputIds=new Set(outputs.map(item=>item.id));
  if(inputIds.size!==inputs.length||outputIds.size!==outputs.length)return 'ports';
  for(const output of outputs){
    if(output.passthrough_from&&!inputIds.has(output.passthrough_from))return 'passthrough';
    if(output.flow_mode&&!['forward','retry','loop'].includes(output.flow_mode))return 'flow_mode';
    if(output.flow_mode&&output.type!=='control')return 'flow_type';
  }
  if(!spec.flow)return '';
  const flow=flowContract(spec);if(!flow)return 'flow_version';
  if(flow.kind==='retry_decision'){
    const success=outputs.find(item=>item.id===flow.success_output),retry=outputs.find(item=>item.id===flow.retry_output);
    if(!inputIds.has(flow.payload_input)||success?.passthrough_from!==flow.payload_input||retry?.type!=='control'||retry?.flow_mode!=='retry')return 'retry_decision';
    return '';
  }
  if(flow.kind==='retry_counter'){
    const trigger=inputs.find(item=>item.id===flow.trigger_input),continuation=outputs.find(item=>item.id===flow.continue_output),exhausted=outputs.find(item=>item.id===flow.exhausted_output);
    if(trigger?.type!=='control'||continuation?.flow_mode!=='loop'||exhausted?.flow_mode!=='forward'||!spec.config_schema?.properties?.[flow.limit_config])return 'retry_counter';
    return '';
  }
  return 'flow_kind';
}
function connectionKind(vm,sourceNode,output,targetNode,input) {
  if(output?.type!=='control')return 'data';
  if(output.flow_mode==='loop')return 'loop';
  if(output.flow_mode==='retry'){
    const targetFlow=flowContract(nodeMap(vm).get(targetNode?.type));
    return targetFlow?.kind==='retry_counter'&&input?.id===targetFlow.trigger_input?'control':'loop';
  }
  return 'control';
}
function connectionTargetProblem(vm,sourceNode,output,targetNode,input) {
  if(!sourceNode||!targetNode)return {code:'missing_port'};
  if(sourceNode.id===targetNode.id)return {code:'self'};
  const contract=connectionProblem(output,input);if(contract)return contract;
  const kind=connectionKind(vm,sourceNode,output,targetNode,input);
  if((output.type==='control')!==(input.type==='control'))return {code:'type',outputType:output.type,inputType:input.type};
  const existing=incoming(vm,targetNode.id,input.id,kind);
  if(existing.some(edge=>edge.from.node===sourceNode.id&&edge.from.port===output.id))return {code:'duplicate'};
  const maximum=input.max_items??input.maximum;
  if(inputCardinality(input)!=='one'&&maximum!=null&&existing.length>=maximum)return {code:'maximum'};
  return null;
}
function issue(code,message,details={}) { return {severity:'error',code,message,...details}; }
function missing(value) { return value===undefined||value===null||value===''||(Array.isArray(value)&&!value.length); }
function schemaTypeMatches(value,type) {
  if(type==='null')return value===null;
  if(type==='string')return typeof value==='string';
  if(type==='number')return typeof value==='number'&&Number.isFinite(value);
  if(type==='integer')return Number.isInteger(value);
  if(type==='boolean')return typeof value==='boolean';
  if(type==='array')return Array.isArray(value);
  if(type==='object')return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
  return true;
}
function schemaProblem(value,schema={}) {
  const types=Array.isArray(schema.type)?schema.type:[schema.type].filter(Boolean);
  if(types.length&&!types.some(type=>schemaTypeMatches(value,type)))return 'type';
  if(schema.enum&&!schema.enum.some(item=>JSON.stringify(item)===JSON.stringify(value)))return 'enum';
  if(typeof value==='number'&&schema.minimum!=null&&value<schema.minimum)return 'minimum';
  if(typeof value==='number'&&schema.maximum!=null&&value>schema.maximum)return 'maximum';
  if(typeof value==='string'&&schema.minLength!=null&&value.length<schema.minLength)return 'minLength';
  if(typeof value==='string'&&schema.maxLength!=null&&value.length>schema.maxLength)return 'maxLength';
  if(typeof value==='string'&&schema.pattern){try{if(!new RegExp(schema.pattern).test(value))return 'pattern';}catch{return 'pattern';}}
  if(Array.isArray(value)&&schema.minItems!=null&&value.length<schema.minItems)return 'minItems';
  if(Array.isArray(value)&&schema.maxItems!=null&&value.length>schema.maxItems)return 'maxItems';
  return '';
}
function portValueMatches(value,type) {
  if(type==='any')return value!==undefined;
  if(type==='text'||type==='project'||type==='category')return typeof value==='string';
  if(type==='number')return typeof value==='number'&&Number.isFinite(value);
  if(type==='integer')return Number.isInteger(value);
  if(type==='boolean')return typeof value==='boolean';
  if(type==='json')return value!==undefined;
  if(type==='job')return Boolean(value&&typeof value==='object'&&(value.id||value.job_id));
  if(type==='artifact')return Array.isArray(value)||Boolean(value&&typeof value==='object');
  if(['image','video','audio','music','media','asset','upload'].includes(type)){
    const values=Array.isArray(value)?value:[value];if(!values.length)return false;
    return values.every(item=>{if(!item||typeof item!=='object')return false;if(type==='upload')return Boolean(item.upload_id);const kind=item.kind||item.type||item.media_type;return Boolean(item.url||item.path||item.upload_id||item.artifact_url)&&(type==='media'||type==='asset'||!kind||kind===type||(type==='audio'&&kind==='music'));});
  }
  return true;
}
function connectionMessage(vm,problem,output,input) {
  if(problem?.code==='type')return tx(vm,'error.connect_type','不能连接：{a} 不能传给 {b}','Cannot connect: {a} cannot feed {b}',{a:output?.type||'?',b:input?.type||'?'});
  if(problem?.code==='semantic')return tx(vm,'error.connect_semantic','不能连接：端口用途不兼容','Cannot connect: port semantics are incompatible');
  if(problem?.code==='self')return tx(vm,'error.connect_self','节点不能连接到自身','A node cannot connect to itself');
  if(problem?.code==='duplicate')return tx(vm,'error.edge_duplicate','同一端口之间不能重复连线','The same ports cannot be connected more than once');
  if(problem?.code==='maximum')return tx(vm,'error.input_max','此输入端口已达到允许的连接数量','This input port has reached its connection limit');
  return tx(vm,'error.connect','不能连接这些端口','These ports cannot be connected');
}
function validate(vm) {
  const errors = [], catalog = nodeMap(vm), nodeIds=vm.workflow.nodes.map(node=>node.id), ids = new Set(nodeIds);
  if (!vm.workflow.nodes.length) errors.push(issue('empty',tx(vm,'error.empty','请先添加节点再运行','Add at least one node before running')));
  if(ids.size!==nodeIds.length)errors.push(issue('duplicate_node_id',tx(vm,'error.duplicate_node_id','工作流包含重复的节点 ID','Workflow contains duplicate node IDs')));
  const edgeIds=vm.workflow.edges.map(edge=>edge.id);if(new Set(edgeIds).size!==edgeIds.length)errors.push(issue('duplicate_edge_id',tx(vm,'error.duplicate_edge_id','工作流包含重复的连线 ID','Workflow contains duplicate connection IDs')));
  const adjacency = new Map([...ids].map(id => [id, []]));
  for (const node of vm.workflow.nodes) {
    const spec = catalog.get(node.type);
    if (!spec) { errors.push(issue('node_missing',tx(vm,'error.node_missing','缺少节点插件：{type}','Missing node plugin: {type}',{type:node.type}),{nodeId:node.id})); continue; }
    const contractProblem=nodeContractProblem(spec);if(contractProblem){errors.push(issue('node_contract',tx(vm,'error.node_contract','节点契约无效：{name}（{reason}）','Invalid node contract: {name} ({reason})',{name:spec.name,reason:contractProblem}),{nodeId:node.id}));continue;}
    if(spec.available===false)errors.push(issue('unavailable',spec.unavailable_reason||tx(vm,'error.unavailable','{name} 当前不可用','{name} is currently unavailable',{name:spec.name}),{nodeId:node.id}));
    if(spec.source==='resource'||spec.source==='loader'){
      const asset=node.values?.asset;
      if(!asset?.path||asset.project_id!==vm.project?.id)errors.push(issue('resource_invalid',tx(vm,'error.resource_invalid','{name} 的素材无效、未选择或不属于当前项目','{name} media is missing, invalid, or belongs to another project',{name:spec.name}),{nodeId:node.id,portId:'media'}));
    }
    const flow=flowContract(spec);
    if(flow?.kind==='retry_decision'&&vm.workflow.edges.filter(edge=>edge.from.node===node.id&&edge.from.port===flow.retry_output&&['control','loop'].includes(edgeKind(edge))).length!==1)errors.push(issue('failure_target',tx(vm,'error.failure_target','重试判断节点的失败端口必须连接一个重做目标或次数控制','A retry decision output must connect to one retry target or count control'),{nodeId:node.id,portId:flow.retry_output}));
    if(flow?.kind==='retry_counter'&&outgoing(vm,node.id,flow.continue_output,'loop').length!==1)errors.push(issue('loop_target',tx(vm,'error.loop_target','次数控制的继续端口必须连接一个重做目标','Count control Continue must connect to one retry target'),{nodeId:node.id,portId:flow.continue_output}));
    for (const input of spec.inputs || []) {
      const links=input.type==='control'?vm.workflow.edges.filter(edge=>edge.to.node===node.id&&edge.to.port===input.id&&['control','loop'].includes(edgeKind(edge))):incoming(vm,node.id,input.id);
      if (inputCardinality(input) === 'one' && links.length > 1) errors.push(issue('multi_input',tx(vm,'error.multi_input','{name} 的输入 {port} 有多条连线','{name} input {port} has multiple links',{name:spec.name,port:input.name}),{nodeId:node.id,portId:input.id}));
      const contextValue = input.type === 'project' ? vm.project?.id : input.type === 'category' ? vm.categoryId : undefined;
      const direct=node.values?.[input.id],valueCount = asArray(direct).length;
      if (input.required && !links.length && missing(contextValue) && !valueCount) errors.push(issue('required',tx(vm,'error.required','{name} 缺少必填输入 {port}','{name} is missing required input {port}',{name:spec.name,port:input.name}),{nodeId:node.id,portId:input.id}));
      const count = links.length || valueCount;
      const minimum = input.min_items ?? input.minimum;
      const maximum = input.max_items ?? input.maximum;
      if (minimum != null && count < minimum) errors.push(issue('input_min',tx(vm,'error.input_min','{name} 的 {port} 至少需要 {count} 项','{name} {port} requires at least {count} item(s)',{name:spec.name,port:input.name,count:minimum}),{nodeId:node.id,portId:input.id}));
      if (maximum != null && count > maximum) errors.push(issue('input_max',tx(vm,'error.input_max','{name} 的 {port} 最多允许 {count} 项','{name} {port} accepts at most {count} item(s)',{name:spec.name,port:input.name,count:maximum}),{nodeId:node.id,portId:input.id}));
      if(!links.length&&!missing(direct)){const values=inputCardinality(input)==='many'?asArray(direct):[direct];if(!values.every(value=>portValueMatches(value,input.type)))errors.push(issue('input_type',tx(vm,'error.input_value_type','{name} 的 {port} 值类型不正确','{name} {port} has an invalid value type',{name:spec.name,port:input.name}),{nodeId:node.id,portId:input.id}));}
    }
    for (const key of spec.config_schema?.required || []) {
      const fallback=spec.config_schema?.properties?.[key]?.default;
      if (missing(node.config?.[key]??fallback)) errors.push(issue('config_required',tx(vm,'error.config_required','{name} 缺少必填配置 {key}','{name} is missing required configuration {key}',{name:spec.name,key}),{nodeId:node.id,fieldId:key}));
    }
    if(spec.source==='agent'&&node.config?.llm_source==='custom')for(const key of ['api_url','model'])if(missing(node.config?.[key]))errors.push(issue('config_required',tx(vm,'error.config_required','{name} 缺少必填配置 {key}','{name} is missing required configuration {key}',{name:spec.name,key}),{nodeId:node.id,fieldId:key}));
    for(const [key,schema] of Object.entries(spec.config_schema?.properties||{})){const value=node.config?.[key];if(missing(value))continue;const problem=schemaProblem(value,schema);if(problem)errors.push(issue('config_schema',tx(vm,'error.config_invalid','{name} 的参数 {key} 不符合要求','{name} parameter {key} is invalid',{name:spec.name,key}),{nodeId:node.id,fieldId:key}));}
  }
  for (const edge of vm.workflow.edges) {
    const kind=edgeKind(edge);
    if(!['data','control','loop'].includes(kind)){errors.push(issue('edge_kind',tx(vm,'error.edge_kind','连线类型无效','Connection kind is invalid'),{edgeId:edge.id}));continue;}
    const source = vm.workflow.nodes.find(node => node.id === edge.from.node), target = vm.workflow.nodes.find(node => node.id === edge.to.node);
    if (!source || !target) { errors.push(issue('edge_node',tx(vm,'error.edge_node','连线引用了不存在的节点','A connection references a missing node'),{edgeId:edge.id,nodeId:source?.id||target?.id})); continue; }
    const out = port(source,'outputs',edge.from.port,vm), input = port(target,'inputs',edge.to.port,vm);
    if (!out || !input) errors.push(issue('edge_port',tx(vm,'error.edge_port','连线引用了不存在的端口','A connection references a missing port'),{edgeId:edge.id,nodeId:target.id}));
    else if (!compatible(out,input)) errors.push(issue('edge_type',connectionMessage(vm,connectionProblem(out,input),out,input),{edgeId:edge.id,nodeId:target.id,portId:input.id}));
    else if(kind!==connectionKind(vm,source,out,target,input))errors.push(issue('edge_kind',tx(vm,'error.edge_kind','连线类型与端口声明不一致','Connection kind does not match the port contract'),{edgeId:edge.id,nodeId:target.id}));
    else if (vm.workflow.edges.filter(item=>item.id!==edge.id&&item.to.node===target.id&&item.to.port===input.id&&edgeKind(item)===kind).some(item=>item.from.node===edge.from.node&&item.from.port===edge.from.port)) errors.push(issue('edge_duplicate',tx(vm,'error.edge_duplicate','同一端口之间不能重复连线','The same ports cannot be connected more than once'),{edgeId:edge.id,nodeId:target.id,portId:input.id}));
    if(['data','control'].includes(kind))adjacency.get(source.id)?.push(target.id);
  }
  const dataNext=new Map([...ids].map(id=>[id,[]]));for(const edge of vm.workflow.edges)if(edgeKind(edge)==='data')dataNext.get(edge.from.node)?.push(edge.to.node);
  const hasDataPath=(start,end)=>{const seen=new Set(),stack=[start];while(stack.length){const id=stack.pop();if(id===end)return true;if(seen.has(id))continue;seen.add(id);stack.push(...(dataNext.get(id)||[]));}return false;};
  for(const edge of vm.workflow.edges){if(edgeKind(edge)!=='loop')continue;const source=vm.workflow.nodes.find(node=>node.id===edge.from.node),sourceFlow=flowContract(nodeMap(vm).get(source?.type));let terminal=source?.id;if(sourceFlow?.kind==='retry_counter'){const trigger=vm.workflow.edges.find(item=>edgeKind(item)==='control'&&item.to.node===source.id&&item.to.port===sourceFlow.trigger_input);terminal=trigger?.from.node;}if(!terminal||!hasDataPath(edge.to.node,terminal))errors.push(issue('loop_path',tx(vm,'error.loop_path','重做目标必须通过数据路径回到对应的判断节点','Retry target must reach its decision node through a data path'),{edgeId:edge.id,nodeId:edge.to.node}));}
  const state = new Map();
  const visit = id => { if (state.get(id) === 1) return false; if (state.get(id) === 2) return true; state.set(id,1); for (const next of adjacency.get(id) || []) if (!visit(next)) return false; state.set(id,2); return true; };
  if ([...ids].some(id => !visit(id))) errors.push(issue('cycle',tx(vm,'error.cycle','工作流包含循环连接','Workflow contains a cycle')));
  return errors.filter((item,index,list)=>list.findIndex(other=>other.code===item.code&&other.nodeId===item.nodeId&&other.portId===item.portId&&other.edgeId===item.edgeId&&other.message===item.message)===index);
}
function runtimeInputIssue(vm,node,spec,input,value) {
  if(input.required&&missing(value))return issue('runtime_required',tx(vm,'error.runtime_required','{name} 运行时缺少输入 {port}','{name} is missing runtime input {port}',{name:spec.name,port:input.name}),{nodeId:node.id,portId:input.id});
  if(missing(value))return null;
  const values=inputCardinality(input)==='many'?asArray(value):[value];
  if(!values.every(item=>portValueMatches(item,input.type)))return issue('runtime_input_type',tx(vm,'error.runtime_input_type','{name} 的运行时输入 {port} 类型不正确','{name} runtime input {port} has an invalid type',{name:spec.name,port:input.name}),{nodeId:node.id,portId:input.id});
  return null;
}
function runtimeOutputIssue(vm,node,spec,result) {
  for(const output of spec.outputs||[]){
    if(!outgoing(vm,node.id,output.id).length)continue;
    const value=result?.[output.id];
    if(missing(value)&&output.type==='control')continue;
    if(missing(value)&&!output.allow_empty)return issue('runtime_output_missing',tx(vm,'error.runtime_output_missing','{name} 没有产生下游所需的输出 {port}','{name} did not produce required downstream output {port}',{name:spec.name,port:output.name}),{nodeId:node.id,portId:output.id});
    if(missing(value)&&output.allow_empty)continue;
    const values=(output.cardinality==='many'||output.multiple)?asArray(value):[value];
    if(!values.every(item=>portValueMatches(item,output.type)))return issue('runtime_output_type',tx(vm,'error.runtime_output_type','{name} 的输出 {port} 类型不正确','{name} output {port} has an invalid type',{name:spec.name,port:output.name}),{nodeId:node.id,portId:output.id});
  }
  return null;
}
function topo(vm) {
  const indegree = new Map(vm.workflow.nodes.map(node => [node.id,0])), next = new Map(vm.workflow.nodes.map(node => [node.id,[]]));
  for (const edge of vm.workflow.edges) { if(!['data','control'].includes(edgeKind(edge)))continue;indegree.set(edge.to.node,(indegree.get(edge.to.node)||0)+1); next.get(edge.from.node)?.push(edge.to.node); }
  const ready = vm.workflow.nodes.filter(node => !indegree.get(node.id)), result=[];
  while (ready.length) { const node=ready.shift(); result.push(node); for (const id of next.get(node.id)||[]) { indegree.set(id,indegree.get(id)-1); if (!indegree.get(id)) ready.push(vm.workflow.nodes.find(item=>item.id===id)); } }
  return result;
}
function nodeInputs(vm,node,spec,outputs,extra={}) {
  const values={...clone(node.values||{})};
  for(const input of spec.inputs||[]){
    if(input.type==='control')continue;
    const links=incoming(vm,node.id,input.id);
    if(links.length){const linked=links.map(edge=>outputs[edge.from.node]?.[edge.from.port]).filter(value=>value!==undefined);values[input.id]=inputCardinality(input)==='many'?linked:linked[0];}
    else if(input.type==='project')values[input.id]=vm.project.id;
    else if(input.type==='category'&&vm.categoryId!=null)values[input.id]=vm.categoryId;
  }
  return {...values,...extra};
}
async function executeNode(vm,node,outputs,extra={}) {
  const spec=nodeMap(vm).get(node.type),inputs=nodeInputs(vm,node,spec,outputs,extra);
  for(const input of spec.inputs||[]){if(input.type==='control')continue;const problem=runtimeInputIssue(vm,node,spec,input,inputs[input.id]);if(problem){const error=new Error(problem.message);error.validationIssue=problem;throw error;}}
  vm.nodeStates[node.id]={status:'running'};vm.selectedNode=node.id;renderCanvas(vm);setStatus(vm,tx(vm,'status.running','正在运行 {name}','Running {name}',{name:spec.name}));
  const executor=executorFor(spec);if(!executor)throw new Error(tx(vm,'error.executor_missing','节点没有可用的执行器：{name}','Node has no available executor: {name}',{name:spec.name}));
  const result=await executor(vm,node,spec,inputs);
  const outputProblem=runtimeOutputIssue(vm,node,spec,result);if(outputProblem){const error=new Error(outputProblem.message);error.validationIssue=outputProblem;throw error;}
  outputs[node.id]=result;vm.nodeStates[node.id]={status:'completed',outputs:result};renderCanvas(vm);return result;
}
function nodesOnDataPath(vm,targetId,terminalId,ordered) {
  const next=new Map(vm.workflow.nodes.map(node=>[node.id,[]])),previous=new Map(vm.workflow.nodes.map(node=>[node.id,[]]));
  for(const edge of vm.workflow.edges){if(edgeKind(edge)!=='data')continue;next.get(edge.from.node)?.push(edge.to.node);previous.get(edge.to.node)?.push(edge.from.node);}
  const walk=(start,graph)=>{const seen=new Set(),stack=[start];while(stack.length){const id=stack.pop();if(seen.has(id))continue;seen.add(id);stack.push(...(graph.get(id)||[]));}return seen;};
  const after=walk(targetId,next),before=walk(terminalId,previous);return ordered.filter(node=>after.has(node.id)&&before.has(node.id)&&node.id!==terminalId);
}
function retryPlan(vm,node,ordered) {
  const decisionFlow=flowContract(nodeMap(vm).get(node.type));if(decisionFlow?.kind!=='retry_decision')return null;
  const retryEdge=vm.workflow.edges.find(edge=>edge.from.node===node.id&&edge.from.port===decisionFlow.retry_output&&['control','loop'].includes(edgeKind(edge)));
  if(!retryEdge)return null;
  const firstTarget=vm.workflow.nodes.find(item=>item.id===retryEdge.to.node),counterFlow=flowContract(firstTarget&&nodeMap(vm).get(firstTarget.type));
  if(counterFlow?.kind!=='retry_counter')return {decisionFlow,target:firstTarget,counter:null,max:Infinity,path:nodesOnDataPath(vm,firstTarget.id,node.id,ordered)};
  const continuation=vm.workflow.edges.find(edge=>edgeKind(edge)==='loop'&&edge.from.node===firstTarget.id&&edge.from.port===counterFlow.continue_output),target=continuation&&vm.workflow.nodes.find(item=>item.id===continuation.to.node);
  const maximum=Number(firstTarget.config?.[counterFlow.limit_config]);
  return target?{decisionFlow,target,counter:firstTarget,counterFlow,max:Math.max(1,Math.min(1000,maximum||3)),path:nodesOnDataPath(vm,target.id,node.id,ordered)}:null;
}
async function executeRetryFlow(vm,node,outputs,ordered) {
  const loop=retryPlan(vm,node,ordered);if(!loop||!loop.path.length)throw new Error(tx(vm,'error.loop_path','失败端口没有形成有效的重做路径','Failure does not form a valid retry path'));
  let retries=0;
  for(;;){
    const result=await executeNode(vm,node,outputs);if(result?.[loop.decisionFlow.success_output]!==undefined){if(loop.counter){outputs[loop.counter.id]={};vm.nodeStates[loop.counter.id]={status:'skipped'};}return result;}
    if(loop.counter){
      if(retries>=loop.max){const counterResult={[loop.counterFlow.exhausted_output]:true,count:retries};outputs[loop.counter.id]=counterResult;vm.nodeStates[loop.counter.id]={status:'completed',outputs:counterResult};renderCanvas(vm);return result;}
      retries++;const counterResult={[loop.counterFlow.continue_output]:true,count:retries};outputs[loop.counter.id]=counterResult;vm.nodeStates[loop.counter.id]={status:'completed',outputs:counterResult};renderCanvas(vm);
    }
    if(vm.stopRequested)return result;
    await new Promise(resolve=>setTimeout(resolve,0));
    for(const pathNode of loop.path){if(vm.stopRequested)break;await executeNode(vm,pathNode,outputs);}
    if(vm.stopRequested)return result;
  }
}
function shouldSkipNode(vm,node,outputs) {
  const controlEdges=vm.workflow.edges.filter(edge=>edgeKind(edge)==='control'&&edge.to.node===node.id);
  if(controlEdges.length&&!controlEdges.some(edge=>outputs[edge.from.node]?.[edge.from.port]===true))return true;
  const spec=nodeMap(vm).get(node.type);
  for(const input of spec?.inputs||[]){if(input.type==='control'||!input.required)continue;const links=incoming(vm,node.id,input.id);if(links.length&&!links.some(edge=>outputs[edge.from.node]?.[edge.from.port]!==undefined))return true;}
  return false;
}
function valueFromInput(raw, type) {
  if (['text','longtext','password','project','category'].includes(type)) return raw;
  if (type === 'number' || type === 'integer') { const number=Number(raw); if (!Number.isFinite(number)) throw new Error('Not a number'); return type==='integer'?Math.trunc(number):number; }
  if (type === 'boolean') return raw === true || raw === 'true';
  if (typeof raw !== 'string') return raw;
  return raw.trim() ? JSON.parse(raw) : null;
}
function editableInput(input) { return !['project','category','job','artifact','image','video','audio','music','media','asset','upload','control'].includes(input.type)&&input.id!=='source_job'; }
function schemaVisible(node,spec,schema) { return !schema.visible_if||Object.entries(schema.visible_if).every(([field,value])=>(node.config?.[field]??spec.config_schema?.properties?.[field]?.default)===value); }
function nodeHeight(spec,node,vm) {
  if(spec?.source==='resource')return 210;
  if(spec?.loader_kind)return 220;
  if(spec?.source==='preview')return spec.preview_kind==='data'?250:280;
  const portHeight=Math.max(spec?.inputs?.length||0,spec?.outputs?.length||0)*PORT_STEP+8;
  const fields=[
    ...(spec?.inputs||[]).filter(input=>editableInput(input)&&!incoming(vm,node.id,input.id).length).map(input=>({multiline:input.multiline,type:inputCardinality(input)==='many'?'array':input.type})),
    ...Object.values(spec?.config_schema?.properties||{}).filter(schema=>schemaVisible(node,spec,schema)),
  ];
  const controls=fields.reduce((sum,schema,index)=>sum+(index?7:0)+(schema.multiline||Array.isArray(schema.type)||['object','array'].includes(schema.type)?82:schema.type==='boolean'?34:45),0);
  const formHeight=fields.length?controls+21:21;
  return CARD_HEAD+portHeight+formHeight;
}
function nodeRect(node, spec, vm) {
  return {left:node.position.x, top:node.position.y, right:node.position.x+CARD_W, bottom:node.position.y+nodeHeight(spec,node,vm)};
}
function overlaps(a,b) { return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; }
function freeNodePosition(vm, type) {
  const spec=nodeMap(vm).get(type);
  for(let row=0;row<40;row++) for(let column=0;column<3;column++) {
    const position={x:100+column*350,y:100+row*260}, candidate=nodeRect({position},spec,vm);
    if(!vm.workflow.nodes.some(node=>overlaps(candidate,nodeRect(node,nodeMap(vm).get(node.type),vm))))return position;
  }
  return vm.canvasCenter();
}
function portPoint(vm, node, direction, portId) {
  const spec=nodeMap(vm).get(node.type), list=spec?.[direction]||[], index=Math.max(0,list.findIndex(item=>item.id===portId));
  return {x:node.position.x+(direction==='outputs'?CARD_W:0), y:node.position.y+CARD_HEAD+18+index*PORT_STEP};
}
function wirePath(from, to) {
  const dx=Math.max(60,Math.abs(to.x-from.x)*.45);
  return `M${from.x} ${from.y} C${from.x+dx} ${from.y},${to.x-dx} ${to.y},${to.x} ${to.y}`;
}
function renderConnectionPreview(vm, clientX, clientY) {
  if(!vm._ui?.svg||!vm._connectionDrag)return;
  vm._ui.svg.querySelector('.ic-wire-preview')?.remove();
  const target=vm.screenToWorld(clientX,clientY),path=document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('class','ic-wire-preview');path.setAttribute('d',wirePath(vm._connectionDrag.from,target));vm._ui.svg.append(path);
}
function applyViewport(vm) {
  if(!vm._ui)return;
  const view=vm.workflow.viewport,{world,svg,grid}=vm._ui;
  world.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.zoom})`;
  svg.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.zoom})`;
  grid.style.setProperty('--grid-x',`${view.x}px`);grid.style.setProperty('--grid-y',`${view.y}px`);grid.style.setProperty('--grid-size',`${24*view.zoom}px`);
  if(vm._ui.zoomInput)vm._ui.zoomInput.value=String(Math.round(view.zoom*100));
}
function renderWires(vm) {
  if(!vm._ui)return;const {svg}=vm._ui;svg.innerHTML='';
  for(const edge of vm.workflow.edges){const a=vm.workflow.nodes.find(n=>n.id===edge.from.node),b=vm.workflow.nodes.find(n=>n.id===edge.to.node);if(!a||!b)continue;const p1=portPoint(vm,a,'outputs',edge.from.port),p2=portPoint(vm,b,'inputs',edge.to.port);const path=document.createElementNS('http://www.w3.org/2000/svg','path'),invalid=vm.validationIssues?.some(item=>item.edgeId===edge.id);path.setAttribute('d',wirePath(p1,p2));path.setAttribute('class',[edgeKind(edge)==='loop'?'is-loop':edgeKind(edge)==='control'?'is-control':'',vm.selectedEdge===edge.id?'is-selected':'',invalid?'is-invalid':''].filter(Boolean).join(' '));path.addEventListener('pointerdown',event=>{event.stopPropagation();vm.selectedEdge=edge.id;vm.selectedNode='';renderAll(vm);});svg.append(path);}
}
function markDirty(vm) { vm.dirty=true;persistDraft(vm);renderTop(vm); }
function setStatus(vm, message, type='') { vm.message=message; vm.messageType=type; renderStatus(vm);if(type&&vm._ui?.status){vm._ui.status.classList.remove('is-pulsing');void vm._ui.status.offsetWidth;vm._ui.status.classList.add('is-pulsing');} }

function build(vm) {
  vm._host.innerHTML='';
  const shell=el('section','ic-app');
  const top=el('header','ic-topbar');
  const brand=el('div','ic-brand'); brand.append(el('span','ic-brand-mark','∞'),el('strong','',tx(vm,'plugin.name','无限画布','Infinite Canvas')));
  const workflowTabs=el('nav','ic-workflow-tabs');
  const tools=el('div','ic-tools');
  tools.append(control('resource',tx(vm,'action.project_resource','选择项目资源','Choose project media'),()=>vm.pickResource(),'is-resource'),control('file',tx(vm,'action.local_file','导入本地文件','Import local files'),()=>vm._ui.mediaFile.click(),'is-resource'),control('save',tx(vm,'action.save.short','保存','Save'),()=>vm.save()),control('trash',tx(vm,'action.delete','删除工作流','Delete workflow'),()=>vm.deleteWorkflow()),control('import',tx(vm,'action.import','导入 JSON','Import JSON'),()=>vm._ui.file.click()),control('export',tx(vm,'action.export','导出 JSON','Export JSON'),()=>vm.exportJson()),control('check',tx(vm,'action.validate','检查','Validate'),()=>vm.validateWorkflow()),control('fit',tx(vm,'action.fit','适应画布','Fit canvas'),()=>vm.fit()),control('run',tx(vm,'action.run','运行','Run'),()=>vm.run(),'is-run'),control('stop',tx(vm,'action.stop','停止','Stop'),()=>{vm.stopRequested=true;setStatus(vm,tx(vm,'status.stopping','将在当前节点结束后停止','Stopping after the current node'),'warn');},'is-stop'));
  const file=el('input',''); file.type='file'; file.accept='.json,application/json'; file.hidden=true; file.addEventListener('change',event=>vm.importJson(event.target.files?.[0]));
  const mediaFile=el('input','');mediaFile.type='file';mediaFile.accept='image/*,video/*,audio/*';mediaFile.multiple=true;mediaFile.hidden=true;mediaFile.addEventListener('change',event=>{vm.importFiles([...event.target.files]);event.target.value='';});
  top.append(brand,workflowTabs,tools,file,mediaFile);

  const body=el('div','ic-body');
  const library=el('aside','ic-library');
  const visibleCatalog=vm.nodesCatalog.filter(node=>!node.hidden);const libHead=el('div','ic-panel-head'); libHead.append(el('strong','',tx(vm,'nodes.title','节点库','Node library')),el('span','ic-count',String(visibleCatalog.length)));
  const searchWrap=el('label','ic-search'); searchWrap.append(icon('search')); const search=el('input',''); search.placeholder=tx(vm,'nodes.search','搜索节点','Search nodes'); search.value=vm.search; search.addEventListener('input',()=>{vm.search=search.value;renderLibrary(vm);}); searchWrap.append(search);
  const libraryList=el('div','ic-library-list'); library.append(libHead,searchWrap,libraryList);

  const stage=el('main','ic-stage'); stage.tabIndex=0;
  const grid=el('div','ic-grid'); const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('class','ic-wires');
  const world=el('div','ic-world'); grid.append(svg,world); stage.append(grid);
  const dropHint=el('div','ic-drop-hint');dropHint.append(el('span','','＋'),el('strong','',tx(vm,'drop.title','释放以导入资源或工作流','Drop media or a workflow to import')),el('small','',tx(vm,'drop.hint','支持图片、视频、音频，或单个无限画布 JSON 工作流','Images, video, audio, or one Infinite Canvas JSON workflow')));stage.append(dropHint);
  const zoom=el('div','ic-zoom'),zoomInput=el('input','');zoomInput.type='number';zoomInput.min=String(Math.round(ZOOM_MIN*100));zoomInput.max=String(Math.round(ZOOM_MAX*100));zoomInput.step='5';zoomInput.value=String(Math.round(vm.workflow.viewport.zoom*100));zoomInput.title=tx(vm,'zoom.percent','缩放百分比','Zoom percentage');zoomInput.addEventListener('change',()=>vm.setZoomPercent(zoomInput.value));zoomInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();vm.setZoomPercent(zoomInput.value);zoomInput.blur();}});zoom.append(control('minus',tx(vm,'zoom.out','缩小','Zoom out'),()=>vm.zoomAt(.9)),zoomInput,el('span','ic-zoom-percent','%'),control('add',tx(vm,'zoom.in','放大','Zoom in'),()=>vm.zoomAt(1.1))); stage.append(zoom);
  const validation=el('aside','ic-validation');stage.append(validation);

  const status=el('footer','ic-status');
  body.append(library,stage); shell.append(top,body,status); vm._host.append(shell);
  vm._ui={shell,top,workflowTabs,tools,file,mediaFile,libraryList,stage,grid,svg,world,status,zoom,zoomInput,validation};
  bindCanvas(vm); renderAll(vm);
}
function renderAll(vm) { renderTop(vm); renderLibrary(vm); renderCanvas(vm); renderStatus(vm); renderValidation(vm); }
function renderTop(vm) {
  if (!vm._ui) return;
  const tabs=vm._ui.workflowTabs,current=vm.workflow.id;tabs.innerHTML='';const drafts=new Map(vm.browserDrafts.map(item=>[item.workflow.id,item])),all=[...vm.browserDrafts.map(item=>({id:item.workflow.id,name:item.workflow.name,draft:true,dirty:item.dirty})),...vm.workflows.filter(item=>!drafts.has(item.id)).map(item=>({...item,draft:false}))];
  for(const item of all){const tab=el('button',`ic-workflow-tab ${item.id===current?'is-active':''}`);tab.type='button';tab.title=item.name;tab.append(el('span','',`${item.dirty?'• ':''}${item.name}`));tab.addEventListener('click',()=>vm.loadWorkflow(item.id));tabs.append(tab);}const add=el('button','ic-workflow-add','+');add.type='button';add.title=tx(vm,'action.new','新建工作流','New workflow');add.addEventListener('click',()=>vm.newWorkflow());tabs.append(add);
  vm._ui.shell.classList.toggle('is-running',vm.running);
  vm._ui.tools.querySelectorAll('button').forEach(button=>button.disabled=vm.running && !button.classList.contains('is-stop'));
}
function renderLibrary(vm) {
  if (!vm._ui) return; const root=vm._ui.libraryList; root.innerHTML=''; const query=vm.search.trim().toLowerCase();
  const items=vm.nodesCatalog.filter(node=>!node.hidden&&(!query||`${node.plugin_name} ${node.name} ${node.description} ${node.type}`.toLowerCase().includes(query)));
  if (!items.length) { const empty=el('div','ic-empty'); empty.append(el('strong','',vm.nodesCatalog.length?tx(vm,'nodes.no_match','没有匹配节点','No matching nodes'):tx(vm,'nodes.empty','没有可用节点','No nodes available')),el('p','',vm.nodesCatalog.length?tx(vm,'nodes.search_hint','换个关键词试试。','Try another search term.'):tx(vm,'nodes.install_hint','安装生成插件，或把画布专属节点放入 plugins/canvas-nodes。','Install generation plugins or add canvas-only nodes under plugins/canvas-nodes.'))); root.append(empty); return; }
  const nodeButton=spec=>{const item=el('button','ic-library-node');item.type='button';item.draggable=true;item.dataset.type=spec.type;item.append(el('span','ic-node-dot'),el('span','ic-node-copy'));item.lastChild.append(el('strong','',spec.name),el('small','',spec.description||spec.type));item.addEventListener('dragstart',event=>{event.dataTransfer.setData('application/x-videofree-node',spec.type);event.dataTransfer.effectAllowed='copy';});item.addEventListener('dblclick',()=>vm.addNode(spec.type,freeNodePosition(vm,spec.type)));return item;};
  const sectionNames={basic:tx(vm,'nodes.basic','基础节点','Basic nodes'),intelligent:tx(vm,'nodes.intelligent','智能节点','Intelligent nodes'),generation:tx(vm,'nodes.generation','生成插件','Generation plugins'),postprocess:tx(vm,'nodes.postprocess','后处理插件','Post-processing plugins'),canvas:tx(vm,'nodes.canvas','画布扩展','Canvas extensions')};
  const categoryNames={input:tx(vm,'nodes.inputs','输入','Inputs'),media:tx(vm,'nodes.media','媒体','Media'),data:tx(vm,'nodes.data','数据','Data'),control:tx(vm,'nodes.control','流程控制','Flow control'),output:tx(vm,'nodes.output','输出与预览','Output and preview'),agent:tx(vm,'nodes.agent','智能体','Agent')};
  for(const sectionId of ['basic','intelligent','generation','postprocess','canvas']){const sectionItems=items.filter(item=>item.source_group===sectionId);if(!sectionItems.length)continue;root.append(el('div','ic-section-title ic-group-head',sectionNames[sectionId]));if(['basic','intelligent'].includes(sectionId)){const categories=[...new Set(sectionItems.map(item=>item.library_category||'data'))];for(const category of categories){const group=el('section',`ic-node-group ic-built-in-group ${query?'':'is-collapsed'}`),heading=el('button','ic-group-head');heading.type='button';const nodes=sectionItems.filter(item=>(item.library_category||'data')===category);heading.append(el('strong','',categoryNames[category]||category),el('span','',String(nodes.length)));const list=el('div','ic-node-list ic-basic-list');for(const spec of nodes)list.append(nodeButton(spec));heading.addEventListener('click',()=>group.classList.toggle('is-collapsed'));group.append(heading,list);root.append(group);}continue;}const groups=new Map();for(const item of sectionItems){if(!groups.has(item.plugin_id))groups.set(item.plugin_id,[]);groups.get(item.plugin_id).push(item);}for(const [,nodes] of groups){const group=el('section',`ic-node-group ${query?'':'is-collapsed'}`),heading=el('button','ic-group-head');heading.type='button';heading.append(el('strong','',nodes[0].plugin_name),el('span','',String(nodes.length)));const list=el('div','ic-node-list');for(const spec of nodes)list.append(nodeButton(spec));heading.addEventListener('click',()=>group.classList.toggle('is-collapsed'));group.append(heading,list);root.append(group);}}
}
function renderValidation(vm) {
  if(!vm._ui)return;const root=vm._ui.validation,items=vm.validationIssues||[];root.innerHTML='';root.classList.toggle('is-visible',Boolean(items.length));if(!items.length)return;
  const head=el('header','');head.append(el('strong','',tx(vm,'validation.title','运行检查','Workflow check')),el('span','',tx(vm,'validation.count','{count} 个问题','{count} issues',{count:items.length})));
  const close=el('button','','×');close.type='button';close.title=tx(vm,'action.close','关闭','Close');close.addEventListener('click',()=>{vm.validationIssues=[];renderValidation(vm);renderCanvas(vm);});head.append(close);root.append(head);
  const list=el('div','ic-validation-list');for(const item of items){const button=el('button','');button.type='button';button.textContent=item.message;button.addEventListener('click',()=>{if(item.nodeId)vm.focusNode(item.nodeId);else if(item.edgeId){vm.selectedEdge=item.edgeId;vm.selectedNode='';renderCanvas(vm);}});list.append(button);}root.append(list);
}
function previewContent(vm,spec,value,expanded=false) {
  const root=el('div',`ic-output-preview is-${spec.preview_kind||'data'} ${expanded?'is-expanded':''}`);
  if(spec.preview_kind==='data') {
    const data=value?.data??value;root.append(el('pre','',typeof data==='string'?data:JSON.stringify(data,null,2)));return root;
  }
  const items=mediaItems(value,spec.preview_kind).filter(item=>{
    const kind=item.kind==='music'?'audio':item.kind;return !kind||kind===spec.preview_kind;
  });
  if(!items.length){root.append(el('span','ic-preview-empty',tx(vm,'preview.waiting','运行后在这里显示结果','Run the workflow to preview the result')));return root;}
  for(const item of items.slice(0,expanded?12:4)){
    if(spec.preview_kind==='image'){const image=el('img','');image.src=item.url;image.alt=item.name||'';image.loading='lazy';root.append(image);}
    else if(spec.preview_kind==='video'){const video=el('video','');video.src=item.url;video.controls=true;video.preload='metadata';video.playsInline=true;root.append(video);}
    else {const audio=el('audio','');audio.src=item.url;audio.controls=true;audio.preload='metadata';root.append(audio);}
  }
  if(items.length>(expanded?12:4))root.append(el('small','',`+${items.length-(expanded?12:4)}`));
  return root;
}
function previewValue(vm,node,spec) {
  const completed=vm.nodeStates[node.id]?.outputs;
  if(completed)return completed;
  const input=spec.inputs?.[0],edge=input&&incoming(vm,node.id,input.id)[0];
  if(!edge)return undefined;
  const value=vm.nodeStates[edge.from.node]?.outputs?.[edge.from.port];
  if(value===undefined)return undefined;
  return spec.preview_kind==='data'?{data:value}:{media:value};
}
function nodeForm(vm,node,spec) {
  const form=el('div','ic-node-form');
  if(spec?.source==='resource'){
    const asset=node.values?.asset||{},preview=el('div','ic-resource-preview');
    if(asset.type==='image'&&asset.url){const image=el('img','');image.src=asset.url;image.alt=asset.name||'';preview.append(image);}
    else if(asset.type==='video'&&asset.url){const video=el('video','');video.src=asset.url;video.muted=true;video.playsInline=true;video.preload='metadata';preview.append(video);}
    else preview.append(el('span','ic-resource-glyph',asset.type==='audio'||asset.type==='music'?'♫':'◇'));
    const copy=el('div','ic-resource-copy');copy.append(el('strong','',asset.name||tx(vm,spec.loader_kind?'loader.empty':'resource.missing',spec.loader_kind?'尚未选择文件':'资源不可用',spec.loader_kind?'No file selected':'Media unavailable')),el('small','',asset.type||''));form.append(preview,copy);if(spec.loader_kind){const choose=el('button','ic-load-button',asset.path?tx(vm,'loader.replace','重新选择','Choose another file'):tx(vm,'loader.choose','选择文件','Choose file'));choose.type='button';choose.addEventListener('click',()=>vm.chooseLoaderFile(node,spec));form.append(choose);}return form;
  }
  if(spec?.source==='preview'){
    form.append(previewContent(vm,spec,previewValue(vm,node,spec)));
    return form;
  }
  for(const input of spec?.inputs||[]){if(!editableInput(input)||incoming(vm,node.id,input.id).length)continue;const invalid=vm.validationIssues?.some(item=>item.nodeId===node.id&&item.portId===input.id);form.append(fieldEditor(vm,`${input.name}${input.required?' *':''}`,node.values?.[input.id],inputCardinality(input)==='many'?'json':input.multiline?'longtext':input.type,value=>{node.values[input.id]=value;markDirty(vm);},input.options,invalid));}
  const properties=Object.entries(spec?.config_schema?.properties||{});
  for(const [key,schema] of properties){if(!schemaVisible(node,spec,schema))continue;const schemaType=Array.isArray(schema.type)?'json':schema.format==='password'?'password':schema.multiline?'longtext':schema.type==='integer'?'integer':schema.type==='number'?'number':schema.type==='boolean'?'boolean':schema.type==='object'||schema.type==='array'?'json':'text',invalid=vm.validationIssues?.some(item=>item.nodeId===node.id&&item.fieldId===key),hasDependents=properties.some(([,candidate])=>candidate.visible_if&&Object.hasOwn(candidate.visible_if,key));form.append(fieldEditor(vm,schema.title||key,node.config?.[key]??schema.default,schemaType,value=>{node.config[key]=value;markDirty(vm);if(hasDependents)renderCanvas(vm);},schema.options||schema.enum,invalid));}
  return form;
}
function renderCanvas(vm) {
  if (!vm._ui) return; const {world}=vm._ui; world.innerHTML=''; const view=vm.workflow.viewport;
  applyViewport(vm);renderWires(vm);
  if(!vm.workflow.nodes.length){const empty=el('div','ic-canvas-empty');empty.append(el('span','','∞'),el('strong','',tx(vm,'canvas.empty','从左侧拖入节点开始编排','Drag a node from the left to begin')),el('p','',tx(vm,'canvas.hint','滚轮缩放，拖动画布平移，点击端口完成连线。','Wheel to zoom, drag the canvas to pan, and click ports to connect.')));world.append(empty);}
  for(const node of vm.workflow.nodes){const spec=nodeMap(vm).get(node.type),invalidNode=vm.validationIssues?.some(item=>item.nodeId===node.id);const card=el('article',`ic-node ${vm.selectedNode===node.id?'is-selected':''} ${vm.nodeStates[node.id]?.status?`is-${vm.nodeStates[node.id].status}`:''} ${invalidNode?'is-invalid':''}`);card.dataset.id=node.id;card.style.transform=`translate(${node.position.x}px,${node.position.y}px)`;
    const head=el('header','ic-node-head');head.append(el('span','ic-node-dot'),el('strong','',node.label||spec?.name||node.type));const nodeTools=el('div','ic-node-tools');const duplicate=control('copy',tx(vm,'action.duplicate','复制节点','Duplicate node'),()=>vm.duplicateNode(node),'is-node-copy');const remove=control('close',tx(vm,'action.delete_node','删除节点','Delete node'),()=>{vm.selectedNode=node.id;vm.deleteSelection();},'is-node-delete');nodeTools.append(duplicate,remove);head.append(nodeTools);card.append(head);
    const ports=el('div','ic-ports'); const inputs=el('div','ic-inputs'),outputs=el('div','ic-outputs');
    for(const item of spec?.inputs||[]){const sourceNode=vm.pendingPort&&vm.workflow.nodes.find(value=>value.id===vm.pendingPort.node),source=sourceNode&&port(sourceNode,'outputs',vm.pendingPort.port,vm),problem=source?connectionTargetProblem(vm,sourceNode,source,node,item):null,invalidPort=vm.validationIssues?.some(value=>value.nodeId===node.id&&value.portId===item.id);const row=el('div',`ic-port-row ${invalidPort?'is-invalid':''}`);const dot=el('button',`ic-port is-input type-${item.type} ${source?(problem?'is-incompatible':'is-compatible'):''} ${invalidPort?'is-invalid':''}`);dot.type='button';dot.title=source?(problem?connectionMessage(vm,problem,source,item):tx(vm,'connection.compatible','可以连接','Compatible')):`${item.name} · ${item.type}`;dot.addEventListener('pointerup',event=>{event.stopPropagation();if(vm._connectionDrag){vm._suppressPortClick=true;vm.finishConnection(node,item);}});dot.addEventListener('click',event=>{event.stopPropagation();if(vm._suppressPortClick){vm._suppressPortClick=false;return;}vm.connectTo(node,item);});row.append(dot,el('span','',item.name));inputs.append(row);}
    for(const item of spec?.outputs||[]){const invalidPort=vm.validationIssues?.some(value=>value.nodeId===node.id&&value.portId===item.id),row=el('div',`ic-port-row ${invalidPort?'is-invalid':''}`);const dot=el('button',`ic-port is-output type-${item.type} ${vm.pendingPort?.node===node.id&&vm.pendingPort?.port===item.id?'is-pending':''} ${invalidPort?'is-invalid':''}`);dot.type='button';dot.title=`${item.name} · ${item.type}`;dot.addEventListener('pointerdown',event=>{event.stopPropagation();if(event.button!==0)return;event.preventDefault();vm.startConnection(node,item,event);});dot.addEventListener('click',event=>{event.stopPropagation();if(vm._suppressPortClick){vm._suppressPortClick=false;return;}vm.startConnection(node,item);});row.append(el('span','',item.name),dot);outputs.append(row);}
    ports.append(inputs,outputs);card.append(ports,nodeForm(vm,node,spec));card.addEventListener('pointerdown',event=>{if(event.button!==0||event.target.closest('button,input,select,textarea,label,audio,video,[contenteditable="true"]'))return;event.stopPropagation();vm.selectNode(node.id);});head.addEventListener('pointerdown',event=>{if(event.button!==0||event.target.closest('button'))return;event.stopPropagation();vm.selectedNode=node.id;vm.selectedEdge='';for(const item of vm._ui.world.querySelectorAll('.ic-node'))item.classList.toggle('is-selected',item.dataset.id===node.id);renderWires(vm);vm.dragNode(event,node);});world.append(card);}
}
function fieldEditor(vm, label, value, type, onChange, options=null, invalid=false) {
  const wrap=el('label',`ic-field ${invalid?'is-invalid':''}`);wrap.append(el('span','',label));let input;
  if(options){input=el('select','');for(const choice of options){const option=el('option','',String(optionLabel(choice)));option.value=String(optionValue(choice));input.append(option);}input.value=String(value??'');}
  else if(type==='boolean'){input=el('input','');input.type='checkbox';input.checked=Boolean(value);}
  else if(type==='longtext'||['json','asset','image','video','audio','music','media','upload'].includes(type)){input=el('textarea','');input.value=value==null?'':typeof value==='string'?value:JSON.stringify(value,null,2);input.rows=type==='longtext'?3:4;}
  else{input=el('input','');input.type=['number','integer'].includes(type)?'number':type==='password'?'password':'text';input.value=value??'';if(type==='integer')input.step='1';}
  input.addEventListener('change',()=>{try{onChange(type==='boolean'?input.checked:valueFromInput(input.value,type));input.classList.remove('is-error');}catch{input.classList.add('is-error');}});wrap.append(input);return wrap;
}
function renderStatus(vm) {
  if(!vm._ui)return;const root=vm._ui.status;root.innerHTML='';const left=el('div','');const state=el('span',`ic-status-dot ${vm.messageType?'is-'+vm.messageType:''}`);left.append(state,el('span','',vm.message||tx(vm,'status.ready','就绪','Ready')));const right=el('div','');right.append(el('span','',tx(vm,'status.nodes','{count} 个节点','{count} nodes',{count:vm.workflow.nodes.length})),el('span','',tx(vm,'status.edges','{count} 条连线','{count} connections',{count:vm.workflow.edges.length})));root.append(left,right);
}
function bindCanvas(vm) {
  const stage=vm._ui.stage;
  stage.addEventListener('dragover',event=>{const nodeDrag=event.dataTransfer.types.includes('application/x-videofree-node'),fileDrag=event.dataTransfer.types.includes('Files');if(nodeDrag||fileDrag){event.preventDefault();event.dataTransfer.dropEffect='copy';stage.classList.toggle('is-file-drag',fileDrag);}});
  stage.addEventListener('dragleave',event=>{if(!stage.contains(event.relatedTarget))stage.classList.remove('is-file-drag');});
  stage.addEventListener('drop',event=>{stage.classList.remove('is-file-drag');const point=vm.screenToWorld(event.clientX,event.clientY),files=[...event.dataTransfer.files];if(files.length){event.preventDefault();const json=files.filter(file=>file.name.toLowerCase().endsWith('.json')||file.type==='application/json');if(json.length){if(files.length!==1||json.length!==1){setStatus(vm,tx(vm,'error.drop_batch','工作流 JSON 请单独拖入，不能与媒体文件混在一起','Drop a workflow JSON by itself; do not mix it with media files'),'error');return;}vm.importJson(json[0]);return;}vm.importFiles(files,{x:point.x-CARD_W/2,y:point.y-30});return;}const type=event.dataTransfer.getData('application/x-videofree-node');if(!type)return;event.preventDefault();vm.addNode(type,{x:point.x-CARD_W/2,y:point.y-30});});
  stage.addEventListener('wheel',event=>{event.preventDefault();const before=vm.screenToWorld(event.clientX,event.clientY);const old=vm.workflow.viewport.zoom;const next=Math.min(ZOOM_MAX,Math.max(ZOOM_MIN,old*Math.exp(-event.deltaY*.001)));const rect=stage.getBoundingClientRect();vm.workflow.viewport.zoom=next;vm.workflow.viewport.x=event.clientX-rect.left-before.x*next;vm.workflow.viewport.y=event.clientY-rect.top-before.y*next;markDirty(vm);applyViewport(vm);},{passive:false});
  stage.addEventListener('pointerdown',event=>{if(event.button!==0||event.target.closest('.ic-node'))return;vm.selectedNode='';vm.selectedEdge='';vm.pendingPort=null;const start={x:event.clientX,y:event.clientY,vx:vm.workflow.viewport.x,vy:vm.workflow.viewport.y};stage.setPointerCapture(event.pointerId);const move=e=>{vm.workflow.viewport.x=start.vx+e.clientX-start.x;vm.workflow.viewport.y=start.vy+e.clientY-start.y;applyViewport(vm);};const up=()=>{stage.removeEventListener('pointermove',move);markDirty(vm);};stage.addEventListener('pointermove',move);stage.addEventListener('pointerup',up,{once:true});});
}

const CanvasApplication = {
  name:'InfiniteCanvasApplication',
  props:{project:Object,categoryId:{default:null},resourcePicker:Function,locale:{type:String,default:'zh-CN'},t:Function},
  render(){return null;},
  data(){return{};},
  watch:{
    locale(){if(this._host){build(this);this.refresh();}},
    'project.id':function(next,previous){if(next&&next!==previous){this.browserDrafts=readDrafts(next);const restored=this.browserDrafts.at(-1);this.workflow=restored?clone(restored.workflow):emptyWorkflow(tx(this,'workflow.untitled','未命名工作流','Untitled workflow'));this.revision=restored?.revision||0;this.dirty=Boolean(restored?.dirty);if(!restored)persistDraft(this);this.nodeStates={};this.validationIssues=[];this.selectedNode='';this.selectedEdge='';this.refresh();}},
  },
  async mounted(){
    this._style=el('style');this._style.textContent=CANVAS_STYLES;document.head.append(this._style);this._host=el('div','ic-mount');this.$el.parentNode.insertBefore(this._host,this.$el);
    this.workflows=[];this.nodesCatalog=[];this.catalogErrors=[];this.browserDrafts=readDrafts(this.project?.id);const restored=this.browserDrafts.at(-1);this.workflow=restored?clone(restored.workflow):emptyWorkflow(tx(this,'workflow.untitled','未命名工作流','Untitled workflow'));this.revision=restored?.revision||0;this.dirty=Boolean(restored?.dirty);if(!restored)persistDraft(this);this.running=false;this.stopRequested=false;this.selectedNode='';this.selectedEdge='';this.pendingPort=null;this._connectionDrag=null;this._suppressPortClick=false;this.nodeStates={};this.validationIssues=[];this.search='';this.message='';this.messageType='';this._ui=null;
    build(this);await this.refresh();
    this._key=event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();this.save();}else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='d'&&this.selectedNode){event.preventDefault();const node=this.workflow.nodes.find(item=>item.id===this.selectedNode);if(node)this.duplicateNode(node);}else if(['Delete','Backspace'].includes(event.key)&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){event.preventDefault();this.deleteSelection();}else if(event.key==='Escape'){this.pendingPort=null;renderCanvas(this);}};this._beforeUnload=event=>{if(this.dirty){event.preventDefault();event.returnValue='';}};window.addEventListener('keydown',this._key);window.addEventListener('beforeunload',this._beforeUnload);
  },
  beforeUnmount(){window.removeEventListener('keydown',this._key);window.removeEventListener('beforeunload',this._beforeUnload);this._dialogFinish?.(false);this._style?.remove();this._host?.remove();},
  methods:{
    async refresh(){if(!this.project?.id){setStatus(this,tx(this,'error.project','请先选择项目','Select a project first'),'error');return;}try{const [generated,postprocessed,actions,canvas,catalog,list,skills]=await Promise.all([request(`${API}/capabilities?operation=generate`),request(`${API}/capabilities?operation=postprocess`),request(`${API}/plugin-actions?automation=true&include_unavailable=true`),request(`${API}/canvas-nodes`),request(`${API}/plugins`),action('list',this.project.id),action('agent-skills',this.project.id)]);this.nodesCatalog=adaptCatalog(generated,postprocessed,actions,canvas,catalog,this.locale,skills.items||[]);this.catalogErrors=canvas.errors||[];this.workflows=list.items||[];if(this.catalogErrors.length)setStatus(this,tx(this,'status.catalog_warning','部分画布专属节点加载失败，请检查网关日志','Some canvas-only nodes failed to load; check gateway logs'),'warn');else setStatus(this,tx(this,'status.ready','就绪','Ready'));renderAll(this);}catch(error){setStatus(this,error.message,'error');renderAll(this);}},
     newWorkflow(){if(this.running)return;persistDraft(this);this.workflow=emptyWorkflow(tx(this,'workflow.untitled_number','未命名工作流 {count}','Untitled workflow {count}',{count:this.browserDrafts.length+1}));this.revision=0;this.dirty=true;this.nodeStates={};this.validationIssues=[];this.selectedNode='';this.selectedEdge='';persistDraft(this);renderAll(this);},
    async loadWorkflow(id){if(id===this.workflow.id)return;persistDraft(this);const draft=this.browserDrafts.find(item=>item.workflow.id===id);if(draft){this.workflow=clone(draft.workflow);this.revision=draft.revision||0;this.dirty=Boolean(draft.dirty);this.nodeStates={};this.validationIssues=[];this.selectedNode='';this.selectedEdge='';renderAll(this);return;}try{const result=await action('get',this.project.id,{workflow_id:id});this.workflow=clone(result.workflow);this.revision=result.revision;this.dirty=false;this.nodeStates={};this.validationIssues=[];this.selectedNode='';this.selectedEdge='';setStatus(this,tx(this,'status.loaded','工作流已载入','Workflow loaded'),'success');renderAll(this);}catch(error){setStatus(this,error.message,'error');}},
    async save(){if(this.running||!this.project?.id)return;const errors=validate(this).filter(item=>item.code==='cycle');if(errors.length){this.validationIssues=errors;setStatus(this,errors[0].message,'error');renderAll(this);return;}if(!this.revision){const name=await promptName(this,this.workflow.name.startsWith(tx(this,'workflow.untitled','未命名工作流','Untitled workflow'))?'':this.workflow.name);if(!name)return;this.workflow.name=name;}try{const id=this.workflow.id,result=await action('save',this.project.id,{workflow:this.workflow,expected_revision:this.revision});this.revision=result.revision;this.dirty=false;removeDraft(this,id);await this.refresh();setStatus(this,tx(this,'status.saved','已保存修订 {revision}','Saved revision {revision}',{revision:this.revision}),'success');renderAll(this);}catch(error){persistDraft(this);setStatus(this,error.message,'error');}},
    async deleteWorkflow(){if(this.running)return;const id=this.workflow.id;if(!this.revision){removeDraft(this,id);this.workflow=emptyWorkflow(tx(this,'workflow.untitled','未命名工作流','Untitled workflow'));this.revision=0;this.dirty=true;this.nodeStates={};this.validationIssues=[];persistDraft(this);renderAll(this);return;}if(!await ask(this,tx(this,'confirm.delete','删除后无法恢复，确定删除当前工作流？','This cannot be undone. Delete workflow?'),tx(this,'confirm.delete_title','删除工作流','Delete workflow'),tx(this,'action.delete','删除','Delete')))return;try{await action('delete',this.project.id,{workflow_id:id,expected_revision:this.revision});removeDraft(this,id);this.workflow=emptyWorkflow(tx(this,'workflow.untitled','未命名工作流','Untitled workflow'));this.revision=0;this.dirty=true;persistDraft(this);await this.refresh();renderAll(this);}catch(error){setStatus(this,error.message,'error');}},
    exportJson(){const blob=new Blob([JSON.stringify(this.workflow,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=el('a','');a.href=url;a.download=`${this.workflow.name.replace(/[\\/:*?\"<>|]/g,'_')||'workflow'}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),0);},
    async importJson(file){this._ui.file.value='';if(!file)return;try{if(file.size>2_000_000)throw new Error(tx(this,'error.file_size','文件不能超过 2 MB','File must not exceed 2 MB'));const workflow=JSON.parse(await file.text()),problem=workflowFileProblem(workflow);if(problem){const key=problem==='limit'?'error.file_limit':problem==='node'?'error.file_node':problem==='edge'?'error.file_edge':problem==='viewport'?'error.file_viewport':'error.format';const zh={error:{}};throw new Error(tx(this,key,problem==='limit'?'工作流超过节点或连线数量限制':problem==='node'?'工作流包含无效或重复的节点':problem==='edge'?'工作流包含无效的连线或引用':problem==='viewport'?'工作流视口数据无效':'不是受支持的无限画布工作流',problem==='limit'?'Workflow exceeds node or connection limits':problem==='node'?'Workflow contains an invalid or duplicate node':problem==='edge'?'Workflow contains an invalid connection or reference':problem==='viewport'?'Workflow viewport is invalid':'Not a supported infinite-canvas workflow'));}const imported=clone(workflow);imported.id=uid('workflow');imported.name=`${imported.name||tx(this,'workflow.imported','导入工作流','Imported workflow')}`.slice(0,120);imported.viewport=imported.viewport||{x:0,y:0,zoom:1};persistDraft(this);this.workflow=imported;this.revision=0;this.dirty=true;this.nodeStates={};this.selectedNode='';this.selectedEdge='';const errors=validate(this);this.validationIssues=errors;persistDraft(this);setStatus(this,errors.length?tx(this,'status.import_issues','已导入，发现 {count} 个问题','Imported with {count} issues',{count:errors.length}):tx(this,'status.imported','已导入为新工作流','Imported as a new workflow'),errors.length?'warn':'success');renderAll(this);}catch(error){setStatus(this,error.message,'error');}},
    canvasCenter(offset=0){const rect=this._ui.stage.getBoundingClientRect(),point=this.screenToWorld(rect.left+rect.width/2,rect.top+rect.height/2);return{x:Math.round(point.x-CARD_W/2+offset*28),y:Math.round(point.y-90+offset*28)};},
    addResource(asset,position=null){const kind=asset?.type==='music'?'music':asset?.type;if(!['image','video','audio','music'].includes(kind)||!asset?.path)return;const type=`videofree.resource.${kind}`,node={id:uid('node'),type,position:position||this.canvasCenter(),config:{},values:{asset:{project_id:asset.project_id||this.project.id,category_id:asset.category_id||'',name:asset.name||asset.path.split('/').pop(),type:kind,path:asset.path,url:asset.url||''}}};this.workflow.nodes.push(node);this.selectedNode=node.id;this.selectedEdge='';markDirty(this);renderAll(this);},
    pickResource(){if(typeof this.resourcePicker!=='function'){setStatus(this,tx(this,'error.resource_picker','当前工作台未提供项目资源选择器','The project media picker is unavailable'),'error');return;}this.resourcePicker({types:['image','video','audio','music'],onSelect:asset=>this.addResource(asset)});},
    async importAsset(file,kind){setStatus(this,tx(this,'status.importing','正在导入 {name}','Importing {name}',{name:file.name}));const uploaded=await uploadFile(file),response=await request(`${API}/plugin-actions/infinite-canvas.import-asset/execute`,{method:'POST',body:JSON.stringify({project_id:this.project.id,category_id:this.categoryId||null,inputs:{upload_id:uploaded.upload_id,name:file.name,kind}})});return response.result||response;},
    async importFiles(files,position=null){const media=files.filter(file=>/^(image|video|audio)\//.test(file.type));if(!media.length){setStatus(this,tx(this,'error.media_type','只支持图片、视频和音频文件','Only image, video, and audio files are supported'),'error');return;}let imported=0;for(const [index,file] of media.entries()){try{const kind=file.type.startsWith('image/')?'image':file.type.startsWith('video/')?'video':'audio',asset=await this.importAsset(file,kind);this.addResource(asset,position?{x:position.x+index*34,y:position.y+index*34}:this.canvasCenter(index));imported++;}catch(error){setStatus(this,tx(this,'error.import_file','导入 {name} 失败：{error}','Failed to import {name}: {error}',{name:file.name,error:error.message}),'error');return;}}setStatus(this,tx(this,'status.imported_media','已导入 {count} 个项目资源','Imported {count} project media item(s)',{count:imported}),'success');},
    chooseLoaderFile(node,spec){const input=el('input','');input.type='file';input.accept=spec.loader_kind==='image'?'image/*':spec.loader_kind==='video'?'video/*':'audio/*';input.addEventListener('change',async()=>{const file=input.files?.[0];if(!file)return;try{const asset=await this.importAsset(file,spec.loader_kind);node.values.asset={project_id:asset.project_id||this.project.id,category_id:asset.category_id||'',name:asset.name||file.name,type:spec.loader_kind,path:asset.path,url:asset.url||''};this.validationIssues=[];markDirty(this);renderAll(this);setStatus(this,tx(this,'status.loaded_file','已加载 {name}','Loaded {name}',{name:file.name}),'success');}catch(error){setStatus(this,error.message,'error');}});input.click();},
    screenToWorld(x,y){const rect=this._ui.stage.getBoundingClientRect(),v=this.workflow.viewport;return{x:(x-rect.left-v.x)/v.zoom,y:(y-rect.top-v.y)/v.zoom};},
    addNode(type,position){if(!nodeMap(this).has(type))return;const spec=nodeMap(this).get(type),node={id:uid('node'),type,position:{x:Math.round(position.x),y:Math.round(position.y)},config:{},values:{}};const schema=spec?.config_schema?.properties||{};for(const [key,value]of Object.entries(schema))if(value.default!==undefined)node.config[key]=clone(value.default);for(const input of spec?.inputs||[])if(input.default!==undefined)node.values[input.id]=clone(input.default);this.workflow.nodes.push(node);this.selectedNode=node.id;this.selectedEdge='';markDirty(this);renderAll(this);},
    selectNode(id){this.selectedNode=id;this.selectedEdge='';renderCanvas(this);},
    dragNode(event,node){const point=this.screenToWorld(event.clientX,event.clientY),start={x:node.position.x,y:node.position.y,px:point.x,py:point.y};const card=this._ui.world.querySelector(`[data-id="${CSS.escape(node.id)}"]`);this._ui.stage.setPointerCapture(event.pointerId);const move=e=>{const p=this.screenToWorld(e.clientX,e.clientY);node.position.x=Math.round(start.x+p.x-start.px);node.position.y=Math.round(start.y+p.y-start.py);if(card)card.style.transform=`translate(${node.position.x}px,${node.position.y}px)`;renderWires(this);};const up=()=>{this._ui.stage.removeEventListener('pointermove',move);markDirty(this);renderWires(this);};this._ui.stage.addEventListener('pointermove',move);this._ui.stage.addEventListener('pointerup',up,{once:true});},
    duplicateNode(node){const copy=clone(node);copy.id=uid('node');copy.position.x+=32;copy.position.y+=32;copy.label=copy.label?`${copy.label} copy`:'';this.workflow.nodes.push(copy);this.selectedNode=copy.id;markDirty(this);renderAll(this);},
    deleteSelection(){if(this.running)return;if(this.selectedEdge){this.workflow.edges=this.workflow.edges.filter(edge=>edge.id!==this.selectedEdge);this.selectedEdge='';markDirty(this);renderAll(this);return;}if(!this.selectedNode)return;this.workflow.nodes=this.workflow.nodes.filter(node=>node.id!==this.selectedNode);this.workflow.edges=this.workflow.edges.filter(edge=>edge.from.node!==this.selectedNode&&edge.to.node!==this.selectedNode);delete this.nodeStates[this.selectedNode];this.selectedNode='';markDirty(this);renderAll(this);},
     startConnection(node,output,event=null){this.pendingPort={node:node.id,port:output.id,type:output.type};setStatus(this,tx(this,'status.connecting','请选择目标输入端口','Select a target input port'));if(!event){renderCanvas(this);return;}this._connectionDrag={from:portPoint(this,node,'outputs',output.id),startX:event.clientX,startY:event.clientY,moved:false,pointerId:event.pointerId};this._suppressPortClick=true;const move=e=>{if(!this._connectionDrag)return;if(Math.hypot(e.clientX-this._connectionDrag.startX,e.clientY-this._connectionDrag.startY)>3)this._connectionDrag.moved=true;renderConnectionPreview(this,e.clientX,e.clientY);};const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);if(this._connectionDrag){const moved=this._connectionDrag.moved;this._connectionDrag=null;if(moved){this.pendingPort=null;setStatus(this,tx(this,'error.connect_drop','未连接到有效的输入端口','Not connected to a valid input port'),'warn');}else this._suppressPortClick=false;renderCanvas(this);}};window.addEventListener('pointermove',move);window.addEventListener('pointerup',up,{once:true});renderConnectionPreview(this,event.clientX,event.clientY);},
     finishConnection(node,input){if(!this._connectionDrag)return;this.connectTo(node,input);this._connectionDrag=null;},
     connectTo(node,input){if(!this.pendingPort){setStatus(this,tx(this,'status.output_first','请先点击输出端口','Click an output port first'),'warn');return;}const sourceNode=this.workflow.nodes.find(item=>item.id===this.pendingPort.node),output=sourceNode&&port(sourceNode,'outputs',this.pendingPort.port,this),problem=connectionTargetProblem(this,sourceNode,output,node,input);if(problem){setStatus(this,connectionMessage(this,problem,output,input),problem.code==='duplicate'?'warn':'error');this.pendingPort=null;renderCanvas(this);return;}const kind=connectionKind(this,sourceNode,output,node,input);if(inputCardinality(input)==='one')this.workflow.edges=this.workflow.edges.filter(edge=>!(edge.to.node===node.id&&edge.to.port===input.id&&['data','control','loop'].includes(edgeKind(edge))));this.workflow.edges.push({id:uid('edge'),kind,from:{node:sourceNode.id,port:output.id},to:{node:node.id,port:input.id}});this.pendingPort=null;this._connectionDrag=null;this.validationIssues=[];markDirty(this);renderAll(this);},
    validateWorkflow(){const errors=validate(this);this.validationIssues=errors;if(errors.length){const first=errors.find(item=>item.nodeId)||errors[0];if(first.nodeId)this.focusNode(first.nodeId);setStatus(this,errors[0].message+(errors.length>1?` (+${errors.length-1})`:''),'error');renderAll(this);}else{setStatus(this,tx(this,'status.valid','检查通过，可以运行','Validation passed; ready to run'),'success');renderValidation(this);renderCanvas(this);}return errors;},
    async run(){if(this.running)return;const errors=this.validateWorkflow();if(errors.length)return;this.running=true;this.stopRequested=false;this.nodeStates={};this.validationIssues=[];renderAll(this);const outputs={},ordered=topo(this);let current=null;try{for(const node of ordered){if(this.stopRequested)break;if(this.nodeStates[node.id]?.status==='completed'||this.nodeStates[node.id]?.status==='skipped')continue;current=node;try{if(shouldSkipNode(this,node,outputs)){this.nodeStates[node.id]={status:'skipped'};renderCanvas(this);continue;}const spec=nodeMap(this).get(node.type),flow=flowContract(spec);if(flow?.kind==='retry_decision')await executeRetryFlow(this,node,outputs,ordered);else if(flow?.kind!=='retry_counter')await executeNode(this,node,outputs);}catch(error){this.nodeStates[node.id]={status:'failed',error:error.message};this.validationIssues=[error.validationIssue||issue('execution',error.message,{nodeId:node.id})];for(const pending of ordered)if(!this.nodeStates[pending.id])this.nodeStates[pending.id]={status:'skipped'};throw error;}}if(this.stopRequested)setStatus(this,tx(this,'status.stopped','运行已停止','Run stopped'),'warn');else setStatus(this,tx(this,'status.completed','工作流运行完成','Workflow run completed'),'success');}catch(error){setStatus(this,error.message,'error');if(current)this.selectedNode=current.id;}finally{this.running=false;renderAll(this);}},
    focusNode(id){const node=this.workflow.nodes.find(item=>item.id===id);if(!node)return;const rect=this._ui.stage.getBoundingClientRect(),zoom=this.workflow.viewport.zoom,spec=nodeMap(this).get(node.type);this.workflow.viewport.x=rect.width/2-(node.position.x+CARD_W/2)*zoom;this.workflow.viewport.y=rect.height/2-(node.position.y+nodeHeight(spec,node,this)/2)*zoom;this.selectedNode=id;this.selectedEdge='';renderCanvas(this);renderValidation(this);},
    fit(){if(!this.workflow.nodes.length){this.workflow.viewport={x:0,y:0,zoom:1};renderCanvas(this);return;}const rect=this._ui.stage.getBoundingClientRect(),xs=this.workflow.nodes.map(n=>n.position.x),ys=this.workflow.nodes.map(n=>n.position.y),rights=this.workflow.nodes.map(n=>n.position.x+CARD_W),bottoms=this.workflow.nodes.map(n=>n.position.y+nodeHeight(nodeMap(this).get(n.type),n,this));const minX=Math.min(...xs),minY=Math.min(...ys),w=Math.max(...rights)-minX,h=Math.max(...bottoms)-minY,zoom=Math.min(1,Math.max(ZOOM_MIN,Math.min((rect.width-100)/w,(rect.height-100)/h)));this.workflow.viewport={x:(rect.width-w*zoom)/2-minX*zoom,y:(rect.height-h*zoom)/2-minY*zoom,zoom};markDirty(this);renderCanvas(this);},
    setZoomPercent(raw){const percent=Math.min(ZOOM_MAX*100,Math.max(ZOOM_MIN*100,Number(raw)||100));this.workflow.viewport.zoom=percent/100;markDirty(this);applyViewport(this);},
    zoomAt(factor){const v=this.workflow.viewport;v.zoom=Math.min(ZOOM_MAX,Math.max(ZOOM_MIN,v.zoom*factor));markDirty(this);applyViewport(this);}
  }
};

export default CanvasApplication;
