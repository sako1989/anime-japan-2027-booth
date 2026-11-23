import * as THREE from 'three';
import {OrbitControls} from './vendor/controls/OrbitControls.js';
import {GLTFLoader} from './vendor/loaders/GLTFLoader.js';
import {StudioRenderer} from './studio-renderer.js';
import {StudioMaterials} from './studio-materials.js';
export class BoothViewer {
 constructor(canvas,overlay,sections,onSection){
  this.canvas=canvas;this.overlay=overlay;this.sections=sections;this.active=false;this.labels=true;this.currentSection='overall';
  this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#303338');
  this.camera=new THREE.PerspectiveCamera(38,1,.04,150);this.camera.position.set(-15,13,20);
  this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false});this.renderer.outputColorSpace=THREE.SRGBColorSpace;
  this.studio=new StudioRenderer(this.renderer,this.scene,this.camera);
  this.materials=new StudioMaterials(this.renderer);
  this.renderRequested=true;
  this.controls=new OrbitControls(this.camera,canvas);this.controls.enableDamping=true;this.controls.dampingFactor=.08;this.controls.target.set(0,1,0);this.controls.minDistance=2;this.controls.maxDistance=45;this.controls.maxPolarAngle=Math.PI*.49;this.controls.addEventListener('start',()=>this.tween=null);this.controls.addEventListener('change',()=>this.invalidate());
  this.markers=Object.entries(sections).map(([id,s])=>{const el=document.createElement('button');el.className='hotspot';el.textContent=id;el.title=id+' · '+s.name;el.setAttribute('aria-label',id+' · '+s.name);el.onclick=()=>onSection(id);overlay.append(el);return {el,id,p:new THREE.Vector3(s.anchor[0],2.1,-s.anchor[1])};});
  this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(canvas.parentElement);this.controls.update();this.frame=this.frame.bind(this);this.frameHandle=requestAnimationFrame(this.frame);this.onVisibility=()=>{if(!document.hidden)this.invalidate();};document.addEventListener('visibilitychange',this.onVisibility);
 }
 async load(progress){
  if(this.model)return;
  const loader=new GLTFLoader();
  const gltf=await loader.loadAsync('./assets/booth.glb?v=20261123-rear-gate',e=>progress(e.total?`Loading 3D · ${Math.round(e.loaded/e.total*100)}%`:'Loading the booth geometry & artwork…'));
  this.model=gltf.scene;this.prepare(this.model);this.scene.add(this.model);
  this.originalWalls=this.findOriginalWalls(this.model);
  try{
   progress('Loading the Base wall option…');
   const base=await loader.loadAsync('./assets/base-walls.glb?v=20261123-rear-gate');
   this.baseModel=base.scene;this.prepare(this.baseModel);this.baseGroup=this.baseModel.getObjectByName('variant_base');
   if(!this.baseGroup)throw Error('variant_base was not found in base-walls.glb.');
   this.scene.add(this.baseModel);
  }catch(error){this.baseLoadError=error;console.error('Base wall option unavailable:',error);}
  try{
   progress('Loading the Rijal and Jeddah rooflines…');
   const heritage=await loader.loadAsync('./assets/heritage-rooflines.glb?v=20261123-rear-gate');
   this.heritageModel=heritage.scene;this.prepare(this.heritageModel);
   this.heritageGroups={
    rijal:this.findByKey(this.heritageModel,'roofline_rijal'),
    jeddah:this.findByKey(this.heritageModel,'roofline_jeddah')
   };
   this.heritageReplacements={
    rijal:this.replacementNodes(this.heritageGroups.rijal),
    jeddah:this.replacementNodes(this.heritageGroups.jeddah)
   };
   for(const id of ['rijal','jeddah']){
    if(!this.heritageGroups[id]||!this.validRoofline(this.heritageReplacements[id])){
     throw Error(`roofline_${id} must contain exactly ten replacementFor nodes.`);
    }
   }
   this.scene.add(this.heritageModel);
  }catch(error){this.heritageLoadError=error;this.heritageGroups={};this.heritageReplacements={};console.error('Heritage rooflines unavailable:',error);}
  try{
   progress('Loading the rear passage gate…');
   const gate=await loader.loadAsync('./assets/gate.glb?v=20261123-rear-gate');
   this.gateModel=gate.scene;this.prepare(this.gateModel);this.scene.add(this.gateModel);
  }catch(error){this.gateLoadError=error;console.error('Rear passage gate unavailable:',error);}
  this.setVariant('base');this.resize();
 }
 prepare(root){root.traverse(o=>{if(o.isMesh){o.frustumCulled=true;o.castShadow=true;o.receiveShadow=true;if(o.name==='VIP_boundary_-_move_these_four_points_in_XY')o.material=new THREE.MeshStandardMaterial({name:'Web VIP velvet rope',color:0x861d2b,roughness:.85});if(o.name==='VIP_boundary_-_move_these_four_points_in_XY_1')o.material=new THREE.MeshStandardMaterial({name:'Web VIP gold posts',color:0xc9a344,metalness:.8,roughness:.25});const mats=Array.isArray(o.material)?o.material:[o.material];mats.forEach(m=>{if(m.map)m.map.anisotropy=Math.min(8,this.renderer.capabilities.getMaxAnisotropy());});}});this.materials.prepare(root);this.studio.register(root);}
 findOriginalWalls(root){
  const wanted=new Set(['Wall - Diriyah - Entry','Wall - Diriyah - Front Left','Wall - Diriyah - Inner','Wall - Diriyah - Rear'].map(this.wallKey));
  const walls=[];root.traverse(node=>{const extraName=node.userData?.name||node.userData?.extras?.name||node.name;if(node.children.length===0&&wanted.has(this.wallKey(extraName)))walls.push(node);});
  if(walls.length!==4)console.warn(`Expected four original walls; found ${walls.length}.`);
  return walls;
 }
 nodeName(node){return node?.userData?.name||node?.userData?.extras?.name||node?.name||'';}
 // Three's GLTF names may substitute separators, so compare the stable alphanumeric form.
 wallKey(name){return String(name||'').replace(/[^a-z0-9]+/gi,'').toLowerCase();}
 findByKey(root,key){let found=null;root?.traverse(node=>{if(!found&&this.wallKey(this.nodeName(node))===this.wallKey(key))found=node;});return found;}
 replacementFor(node){return node?.userData?.replacementFor||node?.userData?.extras?.replacementFor||'';}
 replacementNodes(root){const nodes=[];root?.traverse(node=>{if(this.replacementFor(node))nodes.push(node);});return nodes;}
 validRoofline(replacements){
  const expected=new Set(['Wall - Diriyah - Rear','Wall - Diriyah - Front Left','Wall - Diriyah - Inner','Wall - Diriyah - Entry'].map(name=>this.wallKey(name)));
  const mapped=replacements.map(node=>this.wallKey(this.replacementFor(node)));
  return replacements.length===10&&new Set(mapped).size===10&&[...expected].every(key=>mapped.includes(key));
 }
 setNodesVisible(nodes,visible){for(const node of nodes)node.visible=visible;}
 setGroupVisible(group,visible){if(group)group.visible=visible;}
 originalNodesFor(replacements){
  const wanted=new Set(replacements.map(node=>this.wallKey(this.replacementFor(node))));
  const matches=[];
  this.model?.traverse(node=>{if(node!==this.model&&wanted.has(this.wallKey(this.nodeName(node))))matches.push(node);});
  return matches;
 }
 setVariant(id){
  if(!this.model)return false;
  const heritage=['diriyah','rijal','jeddah'];
  if(!['base',...heritage].includes(id))return false;
  if(id==='base'&&(!this.baseGroup||this.originalWalls.length!==4))return false;
  if(['rijal','jeddah'].includes(id)&&(!this.heritageGroups?.[id]||!this.validRoofline(this.heritageReplacements?.[id]||[])||this.originalWalls.length!==4))return false;
  this.variant=id;
  // Reset all mutually exclusive wall sets before revealing one. This makes repeated
  // toolbar switches idempotent and prevents old rooflines from overlapping a supplement.
  for(const name of heritage){this.setGroupVisible(this.findByKey(this.model,'variant_'+name),name===id);}
  this.setGroupVisible(this.baseGroup,id==='base');
  for(const name of ['rijal','jeddah'])this.setGroupVisible(this.heritageGroups?.[name],name===id);
  for(const name of ['rijal','jeddah'])this.setNodesVisible(this.originalNodesFor(this.heritageReplacements?.[name]||[]),true);
  for(const wall of this.originalWalls||[])wall.visible=id==='diriyah';
  if(['rijal','jeddah'].includes(id)){
   // The supplement replaces four core walls plus its matching finish and coping nodes.
   // Keep the selected legacy exterior group visible for its unchanged details only.
   this.setNodesVisible(this.originalNodesFor(this.heritageReplacements[id]),false);
  }
  this.studio.invalidateShadows();this.invalidate();
  return true;
 }
 setLabels(value){this.labels=value;this.overlay.hidden=!value;this.invalidate();}
 setActive(value){this.active=value;this.overlay.hidden=!this.labels;if(value)this.invalidate();}
 invalidate(){this.renderRequested=true;}
 dispose(){
  this.active=false;cancelAnimationFrame(this.frameHandle);this.resizeObserver.disconnect();
  document.removeEventListener('visibilitychange',this.onVisibility);this.controls.dispose();
  this.markers.forEach(m=>m.el.remove());this.studio.dispose();this.materials.dispose();
  const geometries=new Set(),materials=new Set(),textures=new Set();
  for(const root of [this.model,this.baseModel,this.heritageModel,this.gateModel])root?.traverse(o=>{if(o.isMesh){geometries.add(o.geometry);for(const m of (Array.isArray(o.material)?o.material:[o.material]))materials.add(m);}});
  for(const m of materials){for(const value of Object.values(m))if(value?.isTexture)textures.add(value);m.dispose();}
  for(const texture of textures)texture.dispose();for(const geometry of geometries)geometry.dispose();this.renderer.dispose();
 }
 resize(){const w=this.canvas.parentElement.clientWidth,h=this.canvas.parentElement.clientHeight;if(!w||!h)return;const pixelRatio=Math.min(devicePixelRatio,w<640?1.5:1.75);this.renderer.setPixelRatio(pixelRatio);this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.studio.resize(w,h,pixelRatio);this.invalidate();}
 focus(id){this.currentSection=id;this.markers.forEach(m=>m.el.classList.toggle('active',m.id===id));if(id==='overall'){this.cameraView('overall');return;}const a=this.sections[id]?.anchor;if(!a)return;
  const targets={S0:{eye:[7,8,13],target:[1.4,.9,2.6]},S1:{eye:[12,8,12],target:[4,1,1.6]},S2:{eye:[9,13,6],target:[3,1,-1.4]},S3:{eye:[-5,11,9],target:[-1.7,.7,0]},S4:{eye:[-6,11,5],target:[-3,1,-2.1]},S5:{eye:[-9,10,9],target:[-3,1,2.3]}};this.move(targets[id].eye,targets[id].target);
 }
 cameraView(name){const views={overall:[[-11,10,15],[0,.9,0]],top:[[0,22,.015],[0,0,0]],front:[[0,7,24],[0,1,0]],rear:[[0,8,-24],[0,1,0]],'rear-gate':[[3.8,3.8,-11],[0,1.7,-3.65]]};let [eye,target]=views[name]||views.overall;const aspect=this.camera.aspect;const scale=aspect<1.2?Math.max(1,1.15/aspect):1;this.move(eye.map(n=>n*scale),target);}
 move(eye,target){this.tween={from:this.camera.position.clone(),to:new THREE.Vector3(...eye),targetFrom:this.controls.target.clone(),targetTo:new THREE.Vector3(...target),start:performance.now(),duration:matchMedia('(prefers-reduced-motion: reduce)').matches?0:750};}
 frame(now){this.frameHandle=requestAnimationFrame(this.frame);if(!this.active||document.hidden)return;if(this.tween){const t=this.tween,u=Math.min(1,(now-t.start)/(t.duration||1)),e=u*u*(3-2*u);this.camera.position.lerpVectors(t.from,t.to,e);this.controls.target.lerpVectors(t.targetFrom,t.targetTo,e);if(u===1)this.tween=null;this.invalidate();}this.controls.update();if(!this.renderRequested)return;this.renderRequested=false;this.studio.render();
  if(this.labels){const w=this.canvas.clientWidth,h=this.canvas.clientHeight;for(const m of this.markers){const p=m.p.clone().project(this.camera);const visible=p.z<1&&p.z>-1&&Math.abs(p.x)<.98&&Math.abs(p.y)<.96;m.el.hidden=!visible;if(visible){m.el.style.left=((p.x+1)/2*w)+'px';m.el.style.top=((-p.y+1)/2*h)+'px';}}}
 }
}
