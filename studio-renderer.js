import * as THREE from 'three';
import {RoomEnvironment} from './vendor/environments/RoomEnvironment.js';
import {EffectComposer} from './vendor/postprocessing/EffectComposer.js';
import {RenderPass} from './vendor/postprocessing/RenderPass.js';
import {GTAOPass} from './vendor/postprocessing/GTAOPass.js';
import {OutputPass} from './vendor/postprocessing/OutputPass.js';

// Lighting and shading belong to the presentation, not the saved design geometry.
export class StudioRenderer {
 constructor(renderer,scene,camera){
  this.renderer=renderer;this.scene=scene;this.camera=camera;this.frames=0;
  this.cutouts=new Set();this.registered=new WeakSet();this.depthMaterials=[];
  scene.background=new THREE.Color('#303338');
  scene.fog=new THREE.Fog('#303338',38,85);
  renderer.toneMapping=THREE.AgXToneMapping;
  renderer.toneMappingExposure=1.05;
  renderer.shadowMap.enabled=true;
  this.supportsFloat=renderer.extensions.has('EXT_color_buffer_float');
  renderer.shadowMap.type=this.supportsFloat?THREE.VSMShadowMap:THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate=false;

  const room=new RoomEnvironment(),pmrem=new THREE.PMREMGenerator(renderer);
  this.environment=pmrem.fromScene(room,.03);
  scene.environment=this.environment.texture;
  scene.environmentIntensity=.3;
  scene.environmentRotation.y=.35;
  room.dispose();pmrem.dispose();

  this.lights=new THREE.Group();this.lights.name='Web | Natural studio';scene.add(this.lights);
  this.key=new THREE.DirectionalLight(0xfff6e9,3.8);
  this.key.position.set(-7,12,-2);this.key.target.position.set(0,1,0);
  this.key.castShadow=true;
  this.key.shadow.mapSize.set(2048,2048);
  Object.assign(this.key.shadow.camera,{left:-9,right:9,top:9,bottom:-9,near:1,far:34});
  this.key.shadow.bias=-.00005;this.key.shadow.normalBias=.02;
  this.key.shadow.radius=24;this.key.shadow.blurSamples=16;
  this.lights.add(this.key,this.key.target);
  this.fill=new THREE.DirectionalLight(0xeaf2ff,.65);this.fill.position.set(9,7,2);
  this.rim=new THREE.DirectionalLight(0xffffff,.5);this.rim.position.set(3,10,-10);
  this.ambient=new THREE.HemisphereLight(0xe6edff,0x514332,.12);
  this.lights.add(this.fill,this.rim,this.ambient);

  this.ground=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:0x0d0f12,roughness:1,metalness:0,envMapIntensity:.32}));
  this.ground.name='Web | Studio shadow floor';this.ground.rotation.x=-Math.PI/2;
  this.ground.position.y=-.25;this.ground.receiveShadow=true;scene.add(this.ground);

  const target=new THREE.WebGLRenderTarget(1,1,{type:this.supportsFloat?THREE.HalfFloatType:THREE.UnsignedByteType,samples:Math.min(4,renderer.capabilities.maxSamples)});
  this.composer=new EffectComposer(renderer,target);
  this.colorPass=new RenderPass(scene,camera);this.composer.addPass(this.colorPass);
  this.ao=new GTAOPass(scene,camera,1,1,undefined,{radius:.32,thickness:.65,distanceExponent:1,distanceFallOff:1,scale:1,samples:16},{radius:5,lumaPhi:8,depthPhi:3,normalPhi:3,samples:16});
  this.ao.blendIntensity=.85;this.ao.enabled=this.supportsFloat;
  // The normal override cannot honor alpha masks. Omit printed cutouts from this
  // buffer so their invisible rectangular margins never become AO silhouettes.
  const override=this.ao._overrideVisibility.bind(this.ao);
  this.ao._overrideVisibility=()=>{
   override();
   for(const mesh of this.cutouts)if(mesh.visible){mesh.visible=false;this.ao._visibilityCache.push(mesh);}
  };
  this.composer.addPass(this.ao);
  this.outputPass=new OutputPass();this.composer.addPass(this.outputPass);
 }
 register(root){
  root.traverse(mesh=>{
   if(!mesh.isMesh||this.registered.has(mesh))return;
   this.registered.add(mesh);
   const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
   if(materials.some(m=>m.transparent&&m.map))this.cutouts.add(mesh);
   // Match the source art's alpha for its cast shadow without changing the art.
   if(materials.length===1&&materials[0].transparent&&materials[0].map){
    const m=materials[0];
    const depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,map:m.map,alphaTest:Math.max(.1,m.alphaTest),side:m.side});
    mesh.customDepthMaterial=depth;this.depthMaterials.push(depth);
   }
  });
 }
 resize(w,h,pixelRatio){this.composer.setPixelRatio(pixelRatio);this.composer.setSize(w,h);}
 invalidateShadows(){this.renderer.shadowMap.needsUpdate=true;}
 render(){
  this.renderer.info.reset();this.renderer.info.autoReset=false;
  this.composer.render();this.renderer.info.autoReset=true;this.frames++;
 }
 dispose(){
  this.scene.remove(this.lights,this.ground);this.scene.environment=null;this.scene.fog=null;
  this.ground.geometry.dispose();this.ground.material.dispose();this.environment.dispose();
  this.key.shadow.dispose();for(const material of this.depthMaterials)material.dispose();
  for(const pass of this.composer.passes)pass.dispose?.();this.composer.dispose();
 }
}
