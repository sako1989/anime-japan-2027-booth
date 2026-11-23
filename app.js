import {FlowSimulation} from './flow-simulation.js';
const $ = s => document.querySelector(s);
const sections = {
 S0:{color:'#e8e5d8',name:'VIP & special guests',anchor:[1.5,-2.8]},S1:{color:'#a653d1',name:'Welcome',anchor:[4.8,-2.6]},S2:{color:'#24afd4',name:'Company introduction',anchor:[3,2.9]},S3:{color:'#b36f88',name:'Activation',anchor:[-1.7,0]},S4:{color:'#466b40',name:'Game IPs',anchor:[-3,2.6]},S5:{color:'#b6a34a',name:'Anime & manga',anchor:[-3,-2.6]}
};
const steps = [
 {id:'plan',chapter:0,nav:'The floor plan',title:'One booth. Six experiences.',kicker:'01 / The foundation',type:'plan'},
 {id:'flow',chapter:0,nav:'People flow simulation',title:'The booth, in motion.',kicker:'02 / The visitor journey',type:'flow'},
 {id:'booth',chapter:0,nav:'Reveal in 3D',title:'From plan to place.',kicker:'03 / The spatial experience',type:'model'},
 {id:'base',chapter:1,nav:'Base',title:'Base',kicker:'04 / Plain wall option',type:'variant',variant:'base'},
 {id:'diriyah',chapter:1,nav:'Diriyah',title:'Diriyah',kicker:'05 / Heritage direction 01',type:'variant',variant:'diriyah'},
 {id:'rijal',chapter:1,nav:'Rijal Al Alma',title:'Rijal Al Alma',kicker:'06 / Heritage direction 02',type:'variant',variant:'rijal'},
 {id:'jeddah',chapter:1,nav:'Jeddah Al Balad',title:'Jeddah Al Balad',kicker:'07 / Heritage direction 03',type:'variant',variant:'jeddah'},
 {id:'compare',chapter:1,nav:'Compare the directions',title:'Four options. One experience.',kicker:'08 / Side-by-side review',type:'compare'},
 {id:'S1',chapter:2,nav:'S1 · Welcome',title:'A welcome with Saudi warmth.',kicker:'09 / Welcome & hospitality',type:'section',section:'S1'},
 {id:'S2',chapter:2,nav:'S2 · Our story',title:'Meet Manga Productions.',kicker:'10 / Introduction',type:'section',section:'S2'},
 {id:'process',chapter:2,nav:'S2 · Sketch to screen',title:'From sketch to screen.',kicker:'11 / The creative process',type:'detail',section:'S2',image:'s2-process.png'},
 {id:'awards',chapter:2,nav:'S2 · Recognition',title:'A place for achievement.',kicker:'12 / Recognition gallery',type:'detail',section:'S2',image:'s2-awards.png'},
 {id:'S3',chapter:2,nav:'S3 · Activation',title:'Choose your world.',kicker:'13 / Central activation',type:'section',section:'S3'},
 {id:'S4',chapter:2,nav:'S4 · Game IPs',title:'Step into play.',kicker:'14 / Game worlds',type:'section',section:'S4'},
 {id:'S5',chapter:2,nav:'S5 · Anime & manga',title:'Stories beyond the frame.',kicker:'15 / Anime & manga',type:'section',section:'S5'},
 {id:'S0',chapter:2,nav:'S0 · Special guests',title:'A dedicated place to connect.',kicker:'16 / VIP & special guests',type:'section',section:'S0'},
 {id:'review',chapter:3,nav:'Discussion & next steps',title:'The next chapter.',kicker:'17 / Management discussion',type:'summary'}
];
let simulation=null;
let index=0,variant='base',mode='3d',viewer=null,viewerPromise=null,content=null,labels=false,transitionId=0;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button=(label,action,active=false)=>`<button class="view-btn ${active?'active':''}" data-action="${action}">${label}</button>`;
function story(kicker,title,lede,points,note='',status=''){
 $('#story-content').innerHTML=`<div class="story-kicker"><span class="section-dot" style="background:${sections[steps[index].section]?.color||'var(--gold)'}"></span>${kicker}</div><h2>${title}</h2><p class="lede">${lede}</p><ol class="points">${points.map((p,i)=>`<li><span class="point-number">0${i+1}</span><span>${p}</span></li>`).join('')}</ol>${status?`<span class="pill ${status.includes('propos')||status.includes('study')?'proposed':''}">${status}</span>`:''}${note?`<p class="note">${note}</p>`:''}`;
}
function legend(){return `<p class="small-title">Explore the sections</p><div class="legend">${Object.entries(sections).map(([id,s])=>`<button data-step="${id}" title="Explore ${s.name}"><i style="background:${s.color};border:1px solid #0002"></i><span><b>${id}</b> ${s.name}</span></button>`).join('')}</div>`;}
const variantNames={base:'Base',diriyah:'Diriyah',rijal:'Rijal Al Alma',jeddah:'Jeddah Al Balad'};
const variantRenderDate={base:'23 November 2026',diriyah:'23 November 2026',rijal:'23 November 2026',jeddah:'23 November 2026'};
function variants(){return `<p class="small-title">Exterior option</p><div class="version-buttons">${Object.keys(variantNames).map(v=>`<button data-variant="${v}" class="${variant===v?'active':''}">${variantNames[v]}</button>`).join('')}</div>`;}
function variantToolbar(){return `<span class="view-sep"></span>${Object.keys(variantNames).map(v=>button(variantNames[v],`variant-${v}`,variant===v)).join('')}`;}
function image(src,alt){$('#image-stage').innerHTML=`<img class="hero-image" src="assets/${src}" alt="${esc(alt)}" data-enlarge="${src}">`;$('#image-stage').className='image-mode'+(steps[index].type==='detail'?' contain':'');}
function showPlan(){
 $('#image-stage').innerHTML=`<div class="plan-wrap"><img src="assets/plan.png" alt="Confirmed S0 to S5 floor plan with visitor flow arrows; entrance lower right, VIP lower centre, introduction upper right, activation centre, games upper left, anime and manga lower left."></div>`;
 $('#view-top').innerHTML=button('↗ Enlarge plan','enlarge-plan');
 $('#visual-caption').textContent='Original section plan · confirmed 8 October 2026';
 $('#interaction-hint').textContent='12 × 9 m · Entrance below';fitPlan();
}
function fitPlan(){const stage=$('#image-stage'),wrap=stage.querySelector('.plan-wrap');if(!wrap)return;const style=getComputedStyle(stage);const w=stage.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),h=stage.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);const width=Math.min(w,h*3402/2552);wrap.style.width=width+'px';wrap.style.height=(width*2552/3402)+'px';}
new ResizeObserver(fitPlan).observe($('#image-stage'));
async function ensureViewer(){
 if(viewer)return viewer;
 if(!viewerPromise){viewerPromise=import('./viewer.js?v=20261123-rear-gate').then(async ({BoothViewer})=>{
  const v=new BoothViewer($('#canvas'),$('#hotspots'),sections,id=>go(id));
  try{await v.load(p=>{$('#loading-label').textContent=p;});viewer=v;window.boothViewer=v;return v;}
  catch(error){v.dispose();throw error;}
 }).catch(e=>{viewerPromise=null;throw e;});}
 return viewerPromise;
}
async function show3D(step,token){
 $('#stage3d').hidden=false;$('#image-stage').hidden=true;
 $('#view-top').innerHTML=button('Studio 3D','3d',true)+button('Saved render','render')+'<span class="view-sep"></span>'+button('Top','top')+button('Rear gate','rear-gate')+button('↺ Reset','reset')+button('Sections','labels',labels)+variantToolbar();
 $('#visual-caption').textContent='Natural studio · '+variantNames[variant];
 $('#interaction-hint').textContent='Drag to orbit · Scroll to zoom';
 if(!viewer){$('#loading').hidden=false;$('#loading-label').textContent='Loading the saved booth model…';}
 try {let v=await ensureViewer();if(token!==transitionId)return;$('#loading').hidden=true;if(!v.setVariant(variant))throw Error(`The ${variantNames[variant]} wall option is unavailable.`);v.setLabels(labels);v.resize();if(!v.hasFocused||v.currentSection!==(step.section||'overall')){v.focus(step.section||'overall');v.hasFocused=true;}v.setActive(true);}
 catch(e){if(token!==transitionId)return;$('#loading').hidden=true;$('#stage3d').hidden=true;$('#image-stage').hidden=false;image(variant+'-front.png','Saved exterior render');$('#visual-caption').textContent='Saved render · 3D unavailable';$('#interaction-hint').textContent='Use the local launcher to load 3D';$('#view-top').innerHTML=button('Retry 3D','3d')+button('Enlarge render','enlarge-render');notify('3D could not load. The saved renders remain available.');console.error(e);}
}
function render(){
 const restoreTabFocus=document.activeElement?.matches('#step-tabs button');
 simulation?.destroy();simulation=null;window.flowSimulation=null;
 const token=++transitionId,step=steps[index];$('.story').classList.toggle('flow-story',step.type==='flow');viewer?.setActive(false);$('#loading').hidden=true;
 const titles={plan:'The floor plan',flow:'Visitor flow',booth:'Explore the booth',base:'Base',compare:'Four exterior options',S0:'VIP & special guests',S1:'Welcome & hospitality',S2:'Manga Productions',process:'From sketch to screen',awards:'Recognition gallery',S3:'Central activation',S4:'Game IPs',S5:'Anime & manga',review:'What comes next'};
 $('#title').textContent=titles[step.id]||step.title;$('#eyebrow').textContent=step.section||['01 / Space & flow','02 / Heritage','03 / Experiences','04 / Review'][step.chapter];
 document.body.dataset.step=step.id;
 $('#step-status').textContent=step.type==='variant'?(step.variant==='base'?'Plain walls':'Exterior study'):step.type==='section'?(step.id==='S2'?'Approved installations':'Experience concept'):step.type==='detail'?'Approved design':'';
 $('#details').hidden=step.type==='flow';
 $('#step-tabs').innerHTML=steps.map((s,i)=>s.chapter===step.chapter?`<button data-nav="${i}" ${i===index?'aria-current="step"':''}>${esc(s.nav.replace('People flow simulation','Visitor flow').replace('Compare the directions','Compare').replace('The floor plan','Floor plan').replace('Reveal in 3D','3D booth').replace('Discussion & next steps','Next steps'))}</button>`:'').join('');
 document.querySelectorAll('[data-chapter]').forEach(b=>{if(Number(b.dataset.chapter)===step.chapter)b.setAttribute('aria-current','true');else b.removeAttribute('aria-current');});document.title=step.nav+' · Anime Japan 2027';
 requestAnimationFrame(()=>{const tabs=$('#step-tabs'),active=tabs.querySelector('[aria-current]');if(active){tabs.scrollLeft=active.offsetLeft-tabs.offsetLeft-tabs.clientWidth/2+active.clientWidth/2;if(restoreTabFocus)active.focus({preventScroll:true});}});
 for(const id of ['stage3d','image-stage','compare-stage','summary-stage'])$('#'+id).hidden=true;
 $('#image-stage').className='';$('#image-stage').innerHTML='';$('#view-top').innerHTML='';$('#story-controls').innerHTML='';$('#visual-caption').textContent='';$('#interaction-hint').textContent='';
 document.querySelectorAll('[data-nav]').forEach(b=>{b.classList.toggle('active',Number(b.dataset.nav)===index);b.classList.toggle('visited',Number(b.dataset.nav)<index);if(Number(b.dataset.nav)===index)b.setAttribute('aria-current','step');else b.removeAttribute('aria-current');});
 $('#step-number').textContent=`${String(index+1).padStart(2,'0')} / ${steps.length}`;$('#progress-bar').style.width=((index+1)/steps.length*100)+'%';$('#step-name').textContent=['The foundation','Heritage directions','The section experience','Management review'][step.chapter];$('#previous').disabled=index===0;$('#next').innerHTML=index===steps.length-1?'Start again <span>↺</span>':`${esc(steps[index+1]?.nav.replace('People flow simulation','Visitor flow')||'Next')} <span>→</span>`;
 if(step.type==='plan'){
  $('#image-stage').hidden=false;showPlan(false);story('The foundation','Designed around the visitor.','Six distinct zones bring hospitality, storytelling and entertainment into one continuous booth.', ['A shared 12 × 9 m footprint across all three exterior directions.','The entrance and company introduction create a clear first chapter.','Games, anime and activation offer different ways to engage.'],'Section meanings and positions follow the confirmed coloured plan.','Confirmed section plan');$('#story-controls').innerHTML=legend();
 }else if(step.type==='flow'){
  $('#image-stage').hidden=false;simulation=new FlowSimulation({stage:$('#image-stage'),story:$('#story-content'),controls:$('#story-controls'),toolbar:$('#view-top'),caption:$('#visual-caption'),hint:$('#interaction-hint')});window.flowSimulation=simulation;
 }else if(step.type==='model'){
  story('The spatial experience','The plan comes to life.','Explore the actual modeled booth, from its organic walls to the section displays and interior layers.',['Orbit the model to understand the enclosure and openings.','Use the top view to connect the model with the floor plan.','Select a section marker to open its story.'],'Web materials simplify Blender shading. The render view preserves the saved presentation appearance.');$('#story-controls').innerHTML=variants();
 }else if(step.type==='variant'){
  const v=content.variants.find(x=>x.id===step.variant);const texts={base:['Plain, clear & adaptable.','Plain neutral walls with straight level tops retain the same curved footprint and interiors.',['A calm exterior option for reviewing the booth without a heritage treatment.','The four replacement walls keep the established curved enclosure and interior layout.','The shared visitor journey and section purposes remain in place.']],diriyah:['Earth, rhythm & warmth.','An earthen facade with triangular motifs gives the booth a warm Diriyah character.',['Textured earth tones wrap the perimeter walls.','Small triangular motifs bring rhythm to the facade.','The shared interior and visitor journey remain in place.']],rijal:['Stone, steps & craft.','Multiple stone-house tops at varied heights give Rijal Almaa its skyline.',['Stepped parapets create a crisp silhouette around the perimeter.','Stone texture and light window details bring contrast and craft.','Compare from the same camera angle to judge the exterior character.']],jeddah:['Plaster, cornice & screens.','Different-height house tops, plaster cornices and timber crowns give Jeddah Al-Balad its skyline.',['Pale plaster gives the facade a light, composed perimeter.','Timber screens add layered shade and detail.','The same section layout supports a consistent visitor experience.']]};const [title,lede,points]=texts[step.variant];story(step.variant==='base'?'Plain wall option':'Heritage direction',title,lede,points,step.variant==='base'?'This option is a neutral wall treatment for comparison; it does not change the booth layout.':'Stylized exhibition facade study. The openings are scenic relief; this is not a historic reconstruction.',step.variant==='base'?'Base option':'Exterior study');$('#story-controls').innerHTML=`<button class="media-preview" data-enlarge="${step.variant}-detail.png"><img src="assets/${step.variant}-detail.png" alt="${v.title} facade detail"><span>Inspect the facade detail ↗</span></button>`;
 }else if(step.type==='compare'){
  $('#compare-stage').hidden=false;$('#compare-stage').innerHTML=Object.keys(variantNames).map(v=>`<article class="compare-card"><img src="assets/${v}-front.png" alt="${variantNames[v]} front exterior"><div><h3>${variantNames[v]}</h3><p>${content.variants.find(x=>x.id===v).subtitle}</p><button data-step="${v}">Explore in 3D →</button></div></article>`).join('');$('#view-top').innerHTML=`<span class="view-btn">FOUR DESIGNS · SHARED FOOTPRINT</span>`;$('#visual-caption').textContent='All exterior comparisons · 23 November 2026';story('The comparison','Choose the exterior option.','The choice is architectural expression; the experience and section purposes stay consistent.',['Base: plain neutral walls with straight level tops.','Diriyah: earthen warmth and triangular motifs.','Rijal Almaa: a varied skyline of stone houses.','Jeddah Al-Balad: varied house tops, plaster cornices and timber screens.'],'No preferred option is recorded here. Use this view to discuss character, brand fit and production development.');
 }else if(step.type==='section'){
  const s=content.sections.find(x=>x.id===step.section);story(step.section+' / '+sections[step.section].name,s.title,s.purpose,s.experience,s.note,s.status.includes('proposed')?'Purpose confirmed · experience proposed':'Approved installations');$('#story-controls').innerHTML=variants();
 }else if(step.type==='detail'){
  if(step.id==='process')story('S2 / Creative process','Imagine → Storyboard → In Colour','The hallway-facing side of the inner wall turns the making of Future’s Folktales into a visual sequence.',['Imagine: introduce the story and visual world.','Storyboard: show illustrative framing studies.','In Colour: the portrait screen presents a silent 20-second artwork montage.'],'Generated studies are labelled as illustrative, not original production storyboards. The montage is not anime episode footage.','Approved · 9 October 2026');
  else story('S2 / Recognition','15 positions. A clear rhythm.','After the left turn, the curved wall presents recognition across three bays and three shelf levels.',['Each bay contains 2 + 2 + 1 trophy positions.','Together, the shelf rows contain 6 + 6 + 3 positions.','The two existing recognition screens are retained.'],'The display design is approved. Trophy shapes are placeholders; actual inventory, sizes, weights and final screen content remain to be confirmed.','Approved gallery · 11 October 2026');
  $('#image-stage').hidden=false;image(step.image,step.title);$('#view-top').innerHTML=button('Detail render','render',true)+button('3D context','3d')+button('↗ Enlarge','enlarge-detail')+(step.id==='process'?button('▶ Watch loop','movie'):'');$('#visual-caption').textContent=step.id==='awards'?'15-trophy design · 11 October 2026':'Process-wall design · 9 October 2026';
  $('#story-controls').innerHTML=step.id==='process'?`<button class="media-preview" data-enlarge="s2-corridor.png"><img src="assets/s2-corridor.png" alt="Eye-level view of the S2 corridor"><span>View from the visitor’s eye level ↗</span></button><p class="small-title" style="margin-top:18px">The concept screen loop</p><video controls muted loop preload="none" poster="assets/s2-process.png"><source src="assets/movie.mp4" type="video/mp4"></video><p class="media-caption">20-second silent artwork montage</p>`:legend();
 }else{
  $('#summary-stage').hidden=false;$('#summary-stage').innerHTML=[['01','Select the exterior direction','Base, Diriyah, Rijal Al Alma or Jeddah Al Balad.'],['02','Develop the activations','Confirm the central experience, game demos and dubbing interaction.'],['03','Finalize the content','Approve timeline copy, screen media and the actual awards inventory.'],['04','Coordinate production','Review fabrication, technical integration and final display specifications.']].map(([n,t,p])=>`<div class="decision-card"><span class="decision-no">${n}</span><div><h3>${t}</h3><p>${p}</p></div></div>`).join('');story('Management review','A shared direction for the next stage.','The section plan gives the booth a clear structure. The plain base and three heritage studies show four wall options.',['Confirmed: S0–S5 purposes and the shared footprint.','Approved additions: the process wall and 15-position recognition gallery.','Open: exterior preference, activation format and final content.'],'This presentation includes the revised wall profiles saved on 12 October and dated feature previews. It is a design review, not a construction package.');$('#story-controls').innerHTML=`<p class="source-label">Prepared for local presentation<br>12 October 2026 · Manga Productions</p><button class="view-btn" data-step="compare">Return to the comparison →</button>`;
 }
 if(['model','variant','section'].includes(step.type)){
  if(mode==='render'){ $('#image-stage').hidden=false;image(variant+'-front.png','Saved '+variantNames[variant]+' exterior render');$('#view-top').innerHTML=button('Studio 3D','3d')+button('Saved render','render',true)+button('↗ Enlarge','enlarge-render')+variantToolbar();$('#visual-caption').textContent='Saved '+(variant==='base'?'base':'exterior')+' render · '+variantRenderDate[variant]; }
  else show3D(step,token);
 }
 if(step.type==='detail'&&mode==='3d'){show3D(step,token);}
}
function go(id){$('#details-dialog').close();$('#story-controls video')?.pause();const n=typeof id==='number'?id:steps.findIndex(s=>s.id===id);if(n<0||n>=steps.length)return;index=n;const step=steps[n];if(step.variant)variant=step.variant;mode=step.type==='detail'?'render':'3d';history.replaceState(null,'','#'+step.id);render();}
function enlarge(file){$('#lightbox-image').src='assets/'+file;$('#lightbox-image').alt=steps[index].title;$('#lightbox-caption').textContent=steps[index].title+' · saved design imagery';$('#lightbox').showModal();}
function notify(s){$('#notice').textContent=s;$('#notice').hidden=false;clearTimeout(window.noticeTimer);window.noticeTimer=setTimeout(()=>$('#notice').hidden=true,5000);}
async function fullscreen(){try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{notify('Use your browser’s fullscreen command to present.');}}
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.dataset.chapter){const first=steps.findIndex(s=>s.chapter===Number(b.dataset.chapter));if(first>=0)go(first);return;}
 if(b.dataset.step){go(b.dataset.step);return;}if(b.dataset.nav){go(Number(b.dataset.nav));return;}
 if(b.dataset.variant){if(steps[index].type==='variant'){go(b.dataset.variant);return;}variant=b.dataset.variant;viewer?.setVariant(variant);render();return;}
 if(b.dataset.enlarge){enlarge(b.dataset.enlarge);return;}
 const action=b.dataset.action;
 if(action==='movie'){$('#movie-dialog').showModal();$('#movie-dialog video').play().catch(()=>{});return;}
 if(action==='3d'||action==='render'){mode=action;render();return;}
 if(action?.startsWith('variant-')){const selected=action.slice('variant-'.length);if(steps[index].type==='variant'){go(selected);return;}variant=selected;viewer?.setVariant(variant);render();return;}
 if(['top','front','rear','rear-gate','reset'].includes(action)){viewer?.cameraView(action==='reset'?'overall':action);return;}
 if(action==='labels'){labels=!labels;viewer?.setLabels(labels);b.classList.toggle('active',labels);return;}
 if(action==='enlarge-plan')enlarge('plan.png');if(action==='enlarge-render')enlarge(variant+'-front.png');if(action==='enlarge-detail')enlarge(steps[index].image);
});
$('#image-stage').addEventListener('click',e=>{if(e.target.dataset.enlarge)enlarge(e.target.dataset.enlarge);});
$('#next').onclick=()=>go(index===steps.length-1?0:index+1);$('#previous').onclick=()=>go(index-1);$('#fullscreen').onclick=fullscreen;$('#close-lightbox').onclick=()=>$('#lightbox').close();$('#lightbox').addEventListener('click',e=>{if(e.target===$('#lightbox'))$('#lightbox').close();});
document.addEventListener('keydown',e=>{if(document.querySelector('dialog[open]')||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;if(e.key==='ArrowRight'||e.key==='PageDown'||(e.key===' '&&e.target===document.body)){e.preventDefault();$('#next').click();}if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();$('#previous').click();}if(e.key.toLowerCase()==='f')fullscreen();if(e.key==='Home')go(0);if(e.key==='End')go(steps.length-1);});
window.addEventListener('hashchange',()=>go(location.hash.slice(1)||'plan'));
try{const res=await fetch('./content.json');if(!res.ok)throw Error('Content unavailable');content=await res.json();$('#chapters').innerHTML=['Space & flow','Heritage','Sections','Review'].map((t,c)=>`<button data-chapter="${c}">${t}</button>`).join('');go(steps.some(s=>s.id===location.hash.slice(1))?location.hash.slice(1):'plan');}
catch(e){$('#story-content').innerHTML='<div class="boot-error"><h2>Start the local presentation</h2><p>Double-click <strong>Open Booth Presentation.command</strong> in this folder. The local server is needed for the 3D model and presentation content.</p></div>';$('#image-stage').hidden=false;$('#image-stage').innerHTML='<img class="hero-image" src="assets/plan.png" alt="Floor plan">';console.error(e);}

$('#details').onclick=()=>$('#details-dialog').showModal();
$('#close-details').onclick=()=>$('#details-dialog').close();
$('#close-movie').onclick=()=>$('#movie-dialog').close();
$('#movie-dialog').addEventListener('close',()=>$('#movie-dialog video').pause());
$('#details-dialog').addEventListener('close',()=>$('#story-controls video')?.pause());
for(const d of [$('#details-dialog'),$('#movie-dialog')])d.addEventListener('click',e=>{if(e.target===d)d.close();});
