// Reference-led flooded melaleuca forest. Boundary/canopy are mapped; internal detail is illustrative.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash, nearestPath, pathPoint } from './wetland-map.js';

import { GLOBALS } from './render/globals.js';
import { photoTexture, photoMaps, metricUVs } from './photo-textures.js';

const UP=new THREE.Vector3(0,1,0);
function cylinder(a,b,r0,r1,segs=5) {
  const av=new THREE.Vector3(...a),bv=new THREE.Vector3(...b),delta=bv.clone().sub(av);
  const g=new THREE.CylinderGeometry(r1,r0,delta.length(),segs,1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP,delta.normalize()));
  g.translate(...av.add(bv).multiplyScalar(.5).toArray());return g;
}
function tinted(g,color) {
  const c=new THREE.Color(color),arr=new Float32Array(g.attributes.position.count*3);
  for(let i=0;i<arr.length;i+=3)arr.set(c.toArray(),i);
  g.setAttribute('color',new THREE.BufferAttribute(arr,3));return g;
}
function makeLeaves() { return photoTexture('wetland/melaleuca-crown.webp'); }

function card(cx,cy,cz,w,h,angle,top=false) {
  const g=new THREE.PlaneGeometry(w,h),p=g.attributes.position,n=g.attributes.normal;
  if(top)g.rotateX(-Math.PI/2);g.rotateY(angle);
  g.translate(cx,cy,cz);
  for(let i=0;i<p.count;i++) {
    const v=new THREE.Vector3(p.getX(i)-cx,(p.getY(i)-cy)*.45+2,p.getZ(i)-cz).normalize();n.setXYZ(i,...v.toArray());
  }
  return g;
}
function treeModel(variant) {
  const lean=variant===1?5.2:variant===2?2.4:.85;
  const bark=[],leaves=[];
  const point=t=>[lean*t*(.4+.6*t),14*t,0];
  for(let k=0;k<4;k++)bark.push(cylinder(point(k/4),point((k+1)/4),.24-.045*k,.19-.04*k,6));
  for(let k=0;k<9;k++) {
    const t=.26+k*.078,a=k*2.4+variant,base=point(t),tip=[base[0]+Math.cos(a)*(2.9+k*.13),base[1]+2.3,Math.sin(a)*(2.5+k*.08)];
    bark.push(cylinder(base,tip,.095-k*.005,.025,5));
    if(k>0) {
      const w=5.2+(k%3)*.7;
      for(const angle of [a+(k%2)*Math.PI/2])leaves.push(card(tip[0],tip[1]+.6,tip[2],w,5.7,angle));
    }
  }
  const crown=point(.97);
  for(const angle of [0,Math.PI/3,Math.PI*2/3])leaves.push(card(crown[0],14.3,0,7,6.5,angle));
  // Dark flooded base and spreading roots read independently of the pale paper bark.
  const roots=[];
  roots.push(cylinder([0,-.3,0],[.035,1.1,0],.36,.23,6));
  for(let k=0;k<4;k++){const a=k*1.57;roots.push(cylinder([Math.cos(a)*.9,-.2,Math.sin(a)*.9],[.03,.55,0],.08,.12,5));}
  return {bark:mergeGeometries(bark),leaves:mergeGeometries(leaves),roots:mergeGeometries(roots)};
}
function foliageMaterial(texture,time,mid=false) {
  const mat=new THREE.MeshLambertMaterial({map:texture,alphaTest:.36,alphaToCoverage:true,side:THREE.DoubleSide});
  const compile=sh=>{
    sh.uniforms.uTime=time;
    sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>',`#include <begin_vertex>
        vec4 root=instanceMatrix*vec4(0.,0.,0.,1.);
        float phase=root.x*.17+root.z*.11;
        transformed.x+=sin(uTime*1.1+phase+position.y*.17)*.018*max(position.y-6.,0.);
        transformed.z+=sin(uTime*.8+phase)*.012*max(position.y-5.,0.);`);
    sh.fragmentShader=sh.fragmentShader.replace('#include <alphatest_fragment>',`
      float leafMip=max(0.,log2(max(fwidth(vMapUv.x),fwidth(vMapUv.y))*1024.));
      diffuseColor.a=min(1.,diffuseColor.a*(1.+.8*leafMip));
      diffuseColor.a*=1.-smoothstep(.78,1.,length((vMapUv-.5)*2.));
      #include <alphatest_fragment>`)
      .replace('#include <normal_fragment_begin>','#include <normal_fragment_begin>\nnormal=normalize(vNormal);');
  };
  mat.onBeforeCompile=compile;
  mat.customProgramCacheKey=()=>mid?'trasu-canopy-mid-photo-v1':'trasu-canopy-near-photo-v1';
  const depth=new THREE.MeshDepthMaterial({map:texture,alphaTest:.36,side:THREE.DoubleSide,depthPacking:THREE.RGBADepthPacking});
  depth.onBeforeCompile=compile;depth.customProgramCacheKey=()=> 'trasu-leaf-wind-depth-photo-v1';
  mat.userData.depthMaterial=depth;
  return mat;
}
function nearRange(material,radius) {
  const clip=sh=>{
    sh.uniforms.uViewPos=GLOBALS.uViewPos;sh.uniforms.uDetailRadius={value:radius};
    sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\n uniform vec3 uViewPos; uniform float uDetailRadius;')
      .replace('#include <project_vertex>',`if(distance((modelMatrix*instanceMatrix*vec4(0.,0.,0.,1.)).xz,uViewPos.xz)>uDetailRadius)transformed=vec3(0.,-1000000.,0.);
        #include <project_vertex>`);
  };
  const compile=material.onBeforeCompile;
  material.onBeforeCompile=sh=>{compile(sh);clip(sh);};
  const key=material.customProgramCacheKey();material.customProgramCacheKey=()=>key+'-near-range';
  const depth=material.userData.depthMaterial || new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking});
  const dc=depth.onBeforeCompile;depth.onBeforeCompile=sh=>{dc(sh);clip(sh);};
  const dk=depth.customProgramCacheKey();depth.customProgramCacheKey=()=>dk+'-near-range';
  material.userData.depthMaterial=depth;
}
function cullNear(material,uniforms,key) {
  const compile=material.onBeforeCompile;
  material.onBeforeCompile=sh=>{
    compile(sh);
    Object.assign(sh.uniforms,uniforms,{uViewPos:GLOBALS.uViewPos});
    sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nattribute float aArch; uniform vec3 uViewPos; uniform float uNearRadius, uMidRadius;')
      .replace('#include <project_vertex>',`transformed.x+=aArch*5.2*pow(max(position.y,0.)/16.,1.7);
        vec2 centre=(instanceMatrix*vec4(0.,0.,0.,1.)).xz;
        float treeDistance=distance((modelMatrix*instanceMatrix*vec4(0.,0.,0.,1.)).xz,uViewPos.xz);
        if(treeDistance<uNearRadius || treeDistance>uMidRadius)transformed=vec3(0.,-1000000.,0.);
        #include <project_vertex>`);
  };
  material.customProgramCacheKey=()=>key;
}
function waterMaterial(texture,map,time) {
  const mat=new THREE.MeshStandardMaterial({color:0xffffff,roughness:.85,metalness:.05,side:THREE.DoubleSide});
  mat.onBeforeCompile=sh=>{
    Object.assign(sh.uniforms,{uCover:{value:texture},uTime:time,uDuckweed:{value:photoTexture('wetland/duckweed-color.webp',{repeat:true})},uViewPos:GLOBALS.uViewPos});
    const common=`uniform sampler2D uCover, uDuckweed; uniform float uTime; uniform vec3 uViewPos; varying vec2 vWetland; varying vec3 vPhotoWorld;
      float wh(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float wn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(wh(i),wh(i+vec2(1,0)),f.x),mix(wh(i+vec2(0,1)),wh(i+1.),f.x),f.y);}`;
    sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 vWetland; varying vec3 vPhotoWorld;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nvWetland=position.xy; vPhotoWorld=(modelMatrix*vec4(position,1.)).xyz;');
    sh.fragmentShader=sh.fragmentShader.replace('#include <common>','#include <common>\n'+common)
      .replace('#include <color_fragment>',`#include <color_fragment>
        vec3 cover=texture2D(uCover,vUv).rgb;
        if(cover.r<.08)discard;
        vec2 p=vWetland;
        float matNoise=wn(p*.035)*.65+wn(p*.11)*.35;
        float gap=smoothstep(.62,.78,matNoise)*.32;
        float channel=cover.b*smoothstep(.38,.50,matNoise);
        float green=(1.-channel*.94)*(1.-gap);
        float photoFade=1.-smoothstep(60.,350.,distance(uViewPos,vPhotoWorld));
        // Two offset/rotated samples and broad cover variation soften repetitions from above.
        vec2 uv=p; vec3 a=texture2D(uDuckweed,uv).rgb;
        vec3 b=texture2D(uDuckweed,mat2(.8,-.6,.6,.8)*uv*.73+vec2(17.3,9.1)).rgb;
        vec3 weed=mix(a,b,wn(p*.27)) * (.82+matNoise*.28);
        weed=mix(vec3(.22,.36,.045)*(.8+matNoise*.35),weed,photoFade);
        float shade=cover.g*(.12+.25*wn(p*.065));
        weed*=1.-shade;
        vec3 water=mix(vec3(.032,.068,.055),vec3(.09,.15,.16),wn(p*.13+uTime*.018));
        float matEdge=smoothstep(.36,.44,wn(p*.33)+wn(p*2.3)*.08);
        green*=mix(1.,matEdge,channel*.48);
        diffuseColor.rgb=mix(water,weed,green);
        diffuseColor.a=1.;`)
      .replace('#include <roughnessmap_fragment>',`#include <roughnessmap_fragment>
        roughnessFactor=mix(.55,.98,green);`)
      .replace('#include <metalnessmap_fragment>',`#include <metalnessmap_fragment>
        metalnessFactor=0.;`)
      .replace('#include <normal_fragment_begin>',`#include <normal_fragment_begin>
        float ripple=wn(p*.6+uTime*.12);
        normal=normalize(normal+vec3(dFdx(ripple),dFdy(ripple),0.)*(1.-green)*.12);`);
  };
  // Supply UV varying even without a conventional map (Three otherwise omits vUv).
  mat.defines={USE_UV:''};mat.customProgramCacheKey=()=> 'trasu-duckweed-photo-v2';return mat;
}

function sampan() {
  const g=new THREE.Group(),wood=new THREE.MeshStandardMaterial({...photoMaps('models','wooden_rough_planks'),color:0x77977c,roughness:1,side:THREE.DoubleSide});
  const p=[],idx=[],L=5.8;
  for(let k=0;k<=12;k++) {
    const z=-L/2+k*L/12,w=.8*Math.pow(Math.sin(Math.PI*k/12),.65)+.06,tip=Math.pow(Math.abs(z)/(L/2),4)*.25;
    p.push(-w,.28+tip,z,-w*.55,-.35+tip,z,w*.55,-.35+tip,z,w,.28+tip,z);
    if(k<12)for(let j=0;j<3;j++){const a=k*4+j,b=a+4;idx.push(a,b,a+1,a+1,b,b+1);}
  }
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(p,3));geo.setIndex(idx);geo.computeVertexNormals();const hull=metricUVs(geo);geo.dispose();g.add(new THREE.Mesh(hull,wood));
  const seatmat=new THREE.MeshStandardMaterial({...photoMaps('models','wooden_rough_planks'),color:0xd6cbb0,roughness:1});
  const trim=new THREE.MeshStandardMaterial({...photoMaps('models','wooden_rough_planks'),color:0x91846f,roughness:1});
  for(let k=0;k<4;k++){const m=new THREE.Mesh(new THREE.BoxGeometry(1.05,.10,.30),seatmat);m.position.set(0,.04,-1.55+k*.95);g.add(m);}
  for(const side of [-1,1])for(let k=0;k<12;k++) {
    const z=-L/2+k*L/12,zz=z+L/12,w=t=>.8*Math.pow(Math.sin(Math.PI*(t+L/2)/L),.65)+.06;
    g.add(new THREE.Mesh(cylinder([side*w(z),.3+Math.pow(Math.abs(z)/(L/2),4)*.25,z],[side*w(zz),.3+Math.pow(Math.abs(zz)/(L/2),4)*.25,zz],.045,.045),trim));
  }
  const skin=new THREE.MeshStandardMaterial({color:0xb99065,roughness:1}),orange=new THREE.MeshStandardMaterial({color:0xe7851b,roughness:1}),hat=new THREE.MeshStandardMaterial({color:0xc4bb8c,roughness:1});
  for(let k=0;k<3;k++) {
    const body=new THREE.Mesh(new THREE.CapsuleGeometry(.20,k===2?.70:.35,2,6),k===2?seatmat:orange);body.position.set(k%2?.12:-.12,k===2?1.0:.48,-1.1+k*.95);g.add(body);
    const head=new THREE.Mesh(new THREE.SphereGeometry(.16,6,4),skin);head.position.copy(body.position).add(new THREE.Vector3(0,k===2?.57:.42,0));g.add(head);
    const cap=new THREE.Mesh(new THREE.ConeGeometry(.31,.16,10),hat);cap.position.copy(head.position).add(new THREE.Vector3(0,.15,0));g.add(cap);
  }
  const paddle=new THREE.Mesh(cylinder([.45,.75,1.1],[1.5,-.05,2.3],.025,.04),trim);g.add(paddle);
  return g;
}

export class TraSuLayer {
  constructor(map,terrain,shared,{mobile=false}={}) {
    this.map=map;this.terrain=terrain;this.shared=shared;this.mobile=mobile;
    this.group=new THREE.Group();this.group.name='Trà Sư flooded forest';this.group.position.set(map.centre[0],0,map.centre[1]);
    this.treeGroup=new THREE.Group();this.boatGroup=new THREE.Group();this.boardwalk=new THREE.Group();this.detail=new THREE.Group();
    this.content=new THREE.Group();this.group.add(this.content);this.content.add(this.treeGroup,this.boatGroup,this.boardwalk,this.detail);
    this.nearR=mobile?80:110;this.built=false;this.last=new THREE.Vector3(Infinity,Infinity,Infinity);this.nearMeshes=[];this.midMeshes=[];this.boats=[];
    this.views=this.makeViews();
  }
  makeViews() {
    const m=this.map,c=m.centre,p=pathPoint(m.data.channels[0].points,.49),q=pathPoint(m.data.channels[0].points,.478);
    const V=(x,y,z)=>new THREE.Vector3(c[0]+x,y,c[1]+z);
    return {trasu:{target:V(200,m.level+10,200),pos:V(1250,m.level+720,1380)},
            trasuCanal:{target:V(q.x,m.level+2.4,q.z),pos:V(p.x,m.level+2.6,p.z)},
            trasuBirds:{target:V(-242,m.level+1.05,204),pos:V(-217,m.level+3.0,237)}};
  }
  async build(local) {
    const m=this.map,[l,t,r,b]=m.data.bounds,texture=await new THREE.TextureLoader().loadAsync('data/trasu-cover.png');
    texture.colorSpace=THREE.NoColorSpace;texture.anisotropy=4;
    const water=new THREE.Mesh(new THREE.PlaneGeometry(r-l,b-t),waterMaterial(texture,m,this.shared.uTime));
    water.rotation.x=-Math.PI/2;water.position.set((l+r)/2,m.level+.025,(t+b)/2);water.userData.noShadow=true;water.receiveShadow=true;this.content.add(water);
    this.records=m.generateTrees(this.mobile?14:11);
    this.records.sort((a,b)=>(a.x-local.x)**2+(a.z-local.z)**2-(b.x-local.x)**2-(b.z-local.z)**2);this.leafTex=makeLeaves();
    this.leafMat=foliageMaterial(this.leafTex,this.shared.uTime);this.midMat=foliageMaterial(this.leafTex,this.shared.uTime,true);
    this.barkMat=new THREE.MeshStandardMaterial({...photoMaps('foliage','bark_willow'),color:0xffffff,roughness:1});
    this.rootMat=new THREE.MeshLambertMaterial({color:0x39382b});this.models=[0,1,2].map(treeModel);
    this.nearUniforms={uNearRadius:{value:0},uMidRadius:{value:10000}};
    this.farUniforms={uNearRadius:{value:0},uMidRadius:{value:10000}};
    this.midBarkMat=new THREE.MeshLambertMaterial({map:photoTexture('foliage/bark_willow-color.webp',{repeat:true})});
    cullNear(this.midBarkMat,this.nearUniforms,'trasu-mid-bark-v1');
    cullNear(this.midMat,this.nearUniforms,'trasu-mid-leaves-v2');
    this.farMat=foliageMaterial(this.leafTex,this.shared.uTime,true);
    cullNear(this.farMat,this.farUniforms,'trasu-far-canopy-v1');
    const midParts=[];
    for(const [x,y,z,w,h] of [[0,9.2,0,6.5,7],[-1.8,12.1,1,6.2,7],[1.6,14.5,-.7,6,6]]) {
      midParts.push(card(x,y,z,w,h,.2),card(x,y,z,w,h,1.75),card(x,y+1.5,z,w,w,.4,true));
    }
    const midLeaf=mergeGeometries(midParts);
    const midBark=cylinder([0,0,0],[0,9,0],.22,.10,4);
    this.midMeshes=[this.instances(midBark,this.records,this.midBarkMat),this.instances(midLeaf,this.records,this.midMat)];
    const farLeaf=mergeGeometries([card(0,11.6,0,10,10,.2,true),card(-1.8,14.0,1,8.5,8.5,.9,true),card(1.6,15.8,-.7,8,8,1.7,true)]);
    this.farMesh=this.instances(farLeaf,this.records,this.farMat);this.farMesh.renderOrder=2;this.treeGroup.add(this.farMesh);
    for(const mesh of [...this.midMeshes,this.farMesh]){mesh.userData.noShadow=true;mesh.geometry.setAttribute('aArch',new THREE.InstancedBufferAttribute(new Float32Array(this.records.map(p=>p.variant===1?1:0)),1));}
    this.midMeshes.forEach(o=>{o.renderOrder=2;this.treeGroup.add(o);});
    for(const mat of [this.barkMat,this.leafMat,this.rootMat])nearRange(mat,this.nearR);
    this.buildBoardwalk();this.buildBirds();this.buildPlants();
    const proto=sampan();
    for(let i=0;i<9;i++){const boat=proto.clone();this.boats.push({mesh:boat,phase:i===0?.483:(i+.3)/10,moored:i===0,dir:i%2?-1:1});this.boatGroup.add(boat);}
    this.built=true;
  }
  instances(geometry,records,material) {
    const mesh=new THREE.InstancedMesh(geometry,material,Math.max(records.length,1));mesh.count=records.length;
    const obj=new THREE.Object3D(),color=new THREE.Color();
    records.forEach((p,i)=>{
      obj.position.set(p.x,this.map.level-.10,p.z);obj.rotation.set(0,p.angle,0);obj.scale.setScalar(p.scale);obj.updateMatrix();mesh.setMatrixAt(i,obj.matrix);
      color.setRGB(p.tint,p.tint*(.98+(p.phase||0)*.06),p.tint*.90);mesh.setColorAt(i,color);
    });
    mesh.computeBoundingSphere();mesh.raycast=()=>{};return mesh;
  }
  refreshNear(local,full) {
    this.last.copy(local);
    for(const mesh of this.nearMeshes){this.treeGroup.remove(mesh);mesh.dispose();}
    this.nearMeshes=[];
    const near=full?this.records.filter(p=>Math.hypot(p.x-local.x,p.z-local.z)<this.nearR+35).slice(0,this.mobile?1300:3400):[];
    this.nearUniforms.uNearRadius.value=full?this.nearR:0;
    this.nearUniforms.uMidRadius.value=full?650:10000;
    this.farUniforms.uNearRadius.value=full?650:0;
    // Upload only the visible mid-distance neighbourhood; avoid shading all 55k forest instances.
    const mid=full?this.records.filter(p=>Math.hypot(p.x-local.x,p.z-local.z)<685):[];
    const obj=new THREE.Object3D(),color=new THREE.Color();
    for(const mesh of this.midMeshes) {
      const arch=mesh.geometry.attributes.aArch;
      mid.forEach((p,i)=>{
        obj.position.set(p.x,this.map.level-.10,p.z);obj.rotation.set(0,p.angle,0);obj.scale.setScalar(p.scale);obj.updateMatrix();mesh.setMatrixAt(i,obj.matrix);
        color.setRGB(p.tint,p.tint*(.98+(p.phase||0)*.06),p.tint*.90);mesh.setColorAt(i,color);
        arch.setX(i,p.variant===1?1:0);
      });
      mesh.count=mid.length;mesh.instanceMatrix.needsUpdate=true;
      if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;
      arch.needsUpdate=true;mesh.computeBoundingSphere();mesh.visible=full;
    }
    this.midMeshes[1].visible=full;this.farMesh.visible=local.y>=this.map.level+80;
    for(let v=0;v<3;v++) {
      const records=near.filter(p=>p.variant===v);
      for(const [part,mat] of [['bark',this.barkMat],['leaves',this.leafMat],['roots',this.rootMat]]) {
        const mesh=this.instances(this.models[v][part],records,mat);mesh.renderOrder=1;this.treeGroup.add(mesh);this.nearMeshes.push(mesh);
      }
    }
  }
  buildBoardwalk() {
    const deck=[],poles=[],path=this.map.data.boardwalk,y=this.map.level+1.3;
    for(let k=1;k<path.length;k++) {
      const a=path[k-1],b=path[k],len=Math.hypot(b[0]-a[0],b[1]-a[1]),angle=Math.atan2(b[0]-a[0],b[1]-a[1]),n=Math.ceil(len/.38);
      for(let i=0;i<n;i++){
        const t=(i+.5)/n,x=a[0]+(b[0]-a[0])*t,z=a[1]+(b[1]-a[1])*t;
        const g=new THREE.BoxGeometry(2.2,.11,.32);g.rotateY(angle);g.translate(x,y,z);deck.push(g);
      }
      for(let i=0;i<len;i+=7) {
        const f=i/len,x=a[0]+(b[0]-a[0])*f,z=a[1]+(b[1]-a[1])*f;
        for(const side of [-1,1]){const dx=Math.cos(angle)*side,dz=-Math.sin(angle)*side;poles.push(cylinder([x+dx,this.map.level-.6,z+dz],[x+dx,y+1.0,z+dz],.055,.045));}
      }
      for(const side of [-1,1]){const dx=Math.cos(angle)*side,dz=-Math.sin(angle)*side;poles.push(cylinder([a[0]+dx,y+.9,a[1]+dz],[b[0]+dx,y+.9,b[1]+dz],.045,.045));}
    }
    this.boardwalk.add(new THREE.Mesh(mergeGeometries(deck),new THREE.MeshStandardMaterial({...photoMaps('models','wooden_rough_planks'),color:0xd3c6ab,roughness:1})),
                       new THREE.Mesh(mergeGeometries(poles),new THREE.MeshStandardMaterial({color:0x5d6642,roughness:1})));
  }
  buildBirds() {
    const geo=[];
    // Long legs, S-curved necks, pointed bills and dark flight feathers: small wading groups.
    for(let k=0;k<24;k++) {
      const white=k%3!==0,x=-260+hash(k,1)*70,z=185+hash(k,2)*50,y=this.map.level+.03,angle=hash(k,3)*6.28;
      const parts=[],body=new THREE.SphereGeometry(.26,8,5);body.scale(1,.82,1.7);body.translate(0,.94,0);parts.push(tinted(body,white?0xd9d9cb:0x656d65));
      for(const side of [-1,1])parts.push(tinted(cylinder([side*.13,0,.08],[side*.13,.84,.05],.018,.022),0x8b7450));
      const neckPoints=[[0,1.04,-.22],[0,1.32,-.12],[0,1.55,-.37],[0,1.61,-.51]].map(p=>new THREE.Vector3(...p));
      parts.push(tinted(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(neckPoints),8,.055,5,false),white?0xd5d4c5:0x7e887a));
      const head=new THREE.SphereGeometry(.1,7,4);head.translate(0,1.62,-.53);parts.push(tinted(head,white?0xb9c3b0:0x9aa291));
      parts.push(tinted(cylinder([0,1.60,-.58],[0,1.56,-.97],.055,0),0xb19739));
      const wing=new THREE.SphereGeometry(.23,7,4);wing.scale(.3,1,1.6);wing.translate(.25,.95,0);parts.push(tinted(wing,white?0x353c34:0x354138));
      const merged=mergeGeometries(parts);merged.rotateY(angle);merged.translate(x,y,z);geo.push(merged);
    }
    this.detail.add(new THREE.Mesh(mergeGeometries(geo),new THREE.MeshStandardMaterial({vertexColors:true,roughness:1})));
  }
  buildPlants() {
    const parts=[];
    for(let k=0;k<7;k++) {
      const angle=k*2.4,len=.14+(k%3)*.025;
      const g=new THREE.BufferGeometry();
      g.setAttribute('position',new THREE.Float32BufferAttribute([0,.018,0,-.055,.035,len*.55,0,.022,len,.055,.035,len*.55,0,.06,len*.55],3));
      g.setAttribute('normal',new THREE.Float32BufferAttribute([0,1,0,0,1,0,0,1,0,0,1,0,0,1,0],3));
      g.setAttribute('uv',new THREE.Float32BufferAttribute([.5,0,0,.55,.5,1,1,.55,.5,.55],2));g.setIndex([0,1,4,1,2,4,2,3,4,3,0,4]);
      g.rotateY(angle);parts.push(g);
    }
    const model=mergeGeometries(parts),plants=[];
    for(let k=0;k<4300;k++) {
      const birds=k>2800,angle=hash(k,1)*Math.PI*2,r=Math.sqrt(hash(k,2))*(birds?50:85);
      const x=(birds?-240:15)+Math.cos(angle)*r,z=(birds?210:170)+Math.sin(angle)*r;
      const channel=nearestPath(x,z,this.map.data.channels);
      if(channel.distance<channel.width*.3 || this.map.sampleLocal(x,z)<.98)continue;
      plants.push({x,z,angle,scale:.65+hash(k,3)*1.1,tint:.8+hash(k,4)*.4});
    }
    const mesh=this.instances(model,plants,new THREE.MeshLambertMaterial({map:photoTexture('wetland/rosette-leaf.webp'),alphaTest:.4,color:0xffffff,side:THREE.DoubleSide}));
    // The rosettes float on the surface, above the submerged tree bases.
    mesh.position.y=.14;this.detail.add(mesh);
    const reeds=[];
    for(let k=0;k<35;k++) {
      const x=-285+hash(k,3)*105,z=178+hash(k,4)*75;
      for(let j=0;j<10;j++) {
        const angle=hash(k,j)*6.28,h=.6+hash(j,k)*1.1,dx=Math.sin(angle)*.35,dz=Math.cos(angle)*.35;
        const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute([x-.025,this.map.level,z,x+.025,this.map.level,z,x+dx,this.map.level+h,z+dz],3));g.setAttribute('normal',new THREE.Float32BufferAttribute([0,1,0,0,1,0,0,1,0],3));g.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,1,0,.5,1],2));g.setIndex([0,1,2]);reeds.push(g);
      }
    }
    this.detail.add(new THREE.Mesh(mergeGeometries(reeds),new THREE.MeshStandardMaterial({map:photoTexture('foliage/young-rice-cards.webp'),alphaTest:.4,color:0xffffff,roughness:1,side:THREE.DoubleSide})));
  }
  update(camera) {
    const local=camera.position.clone().sub(this.group.position),near=Math.hypot(local.x,local.z)<5200 && camera.position.y<5000;
    if(!this.group.visible)return;
    this.content.visible=near;
    if(!near)return;
    // Child layer visibility is controlled independently by the main UI.
    if(!this.built){if(!this.building)this.building=this.build(local).catch(e=>console.warn('Trà Sư detail unavailable',e));return;}
    const immersive=camera.position.y<this.map.level+80;
    const full=camera.position.y<350;
    if(local.distanceTo(this.last)>30 || this.wasFull!==full || this.wasImmersive!==immersive){this.refreshNear(local,full);this.wasFull=full;this.wasImmersive=immersive;}
    this.detail.visible=immersive;
    const time=this.shared.uTime.value;
    for(const b of this.boats){const t=b.moored?b.phase+.001*Math.sin(time*.06):(b.phase+b.dir*time*.00014+10)%1,p=pathPoint(this.map.data.channels[0].points,t);
      b.mesh.position.set(p.x,this.map.level+Math.sin(time*.9+b.phase*10)*.018,p.z);b.mesh.rotation.y=p.angle+(b.dir<0?Math.PI:0);b.mesh.visible=this.map.sampleLocal(p.x,p.z)>.95;}
  }
}
