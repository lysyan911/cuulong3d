// Reference-led flooded melaleuca forest. Boundary/canopy are mapped; internal detail is illustrative.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pathPoint } from './wetland-map.js';
import { TraSuForest } from './trasu-forest.js';

import { GLOBALS } from './render/globals.js';
import { skyUniforms, patchCloudShadow, SKY_GLSL } from './render/atmosphere.js';
import { photoTexture, photoMaps, metricUVs } from './photo-textures.js';

const UP=new THREE.Vector3(0,1,0);
function cylinder(a,b,r0,r1,segs=5) {
  const av=new THREE.Vector3(...a),bv=new THREE.Vector3(...b),delta=bv.clone().sub(av);
  const g=new THREE.CylinderGeometry(r1,r0,delta.length(),segs,1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP,delta.normalize()));
  g.translate(...av.add(bv).multiplyScalar(.5).toArray());return g;
}
// Water (Claude Code, rendering): duckweed (bèo tấm) is a separate floating layer, matte and bright, in clumps with
// ragged edges; between the clumps open water is dark tannin brown, glossy and rippled, mirroring the trunks, boats
// and the sky through the canopy (render/reflection.js pass at the wetland level; sky and clouds by Fresnel).
function waterMaterial(texture,map,time) {
  const mat=new THREE.MeshStandardMaterial({color:0xffffff,roughness:.85,metalness:0,side:THREE.DoubleSide});
  mat.onBeforeCompile=sh=>{
    Object.assign(sh.uniforms,{uCover:{value:texture},uTime:time,uDuckweed:{value:photoTexture('wetland/duckweed-color.webp',{repeat:true})},uViewPos:GLOBALS.uViewPos});
    const common=`uniform sampler2D uCover, uDuckweed; uniform float uTime; uniform vec3 uViewPos; varying vec2 vWetland; varying vec3 vPhotoWorld;
      float wh(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float wn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(wh(i),wh(i+vec2(1,0)),f.x),mix(wh(i+vec2(0,1)),wh(i+1.),f.x),f.y);}
      // ripple height: two wave trains drifting across each other
      float rip(vec2 q,float t){return wn(q*.9+vec2(t*.35,t*.21))*.6+wn(q*2.3-vec2(t*.5,-t*.42))*.4;}
      float openK; vec2 ripN;`;
    sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 vWetland; varying vec3 vPhotoWorld;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nvWetland=position.xy; vPhotoWorld=(modelMatrix*vec4(position,1.)).xyz;');
    sh.fragmentShader=sh.fragmentShader.replace('#include <common>','#include <common>\n'+common)
      .replace('#include <lights_pars_begin>',`${SKY_GLSL}\n#include <lights_pars_begin>`)
      .replace('#include <color_fragment>',`#include <color_fragment>
        vec3 cover=texture2D(uCover,vUv).rgb;                     // r flooded, g canopy, b open channel
        if(cover.r<.08)discard;
        vec2 p=vWetland;
        float dist=distance(uViewPos,vPhotoWorld);
        // duckweed clumps: carpets under the trees with a few gaps, a drifting film in the channels
        vec2 q=p+vec2(uTime*.04,uTime*.025)*cover.b;
        float blobs=wn(q*.045)*.55+wn(q*.14)*.3+wn(q*.55)*.15;
        float thick=1.-cover.b;
        float e=blobs*.9+thick*.24-(1.-thick)*.2;                    // channels: open water, drifting patches
        float edgeFine=wn(q*3.1)*.05+wn(q*9.)*.03*(1.-smoothstep(10.,40.,dist));
        float green=smoothstep(.44,.47,e+edgeFine);
        green=max(green,step(.985,wn(q*6.5))*step(.3,e)*.9);    // stray fronds floating in the open water
        openK=1.-green;
        // duckweed: photo texture, bright and matte; brighter where sunlit gaps in the canopy fall on it
        float photoFade=1.-smoothstep(60.,350.,dist);
        vec3 a=texture2D(uDuckweed,p).rgb, b=texture2D(uDuckweed,mat2(.8,-.6,.6,.8)*p*.73+vec2(17.3,9.1)).rgb;
        vec3 weed=mix(a,b,wn(p*.27))*(.9+blobs*.3);
        float mott=wn(p*.9)*.6+wn(p*3.7)*.4;                          // clumps, older yellowish fronds
        weed=mix(vec3(.2,.38,.04)*(.78+blobs*.3+mott*.25),weed,photoFade);
        weed*=mix(vec3(1.),vec3(1.08,1.12,.9),wn(p*.08));          // yellower and greener patches
        // open water: dark, tannin-stained, a little greener under the duckweed film
        vec3 water=mix(vec3(.018,.026,.018),vec3(.035,.045,.03),wn(p*.07));
        diffuseColor.rgb=mix(water,weed,green);
        // ripples (open water only), finite differences of the analytic height (no blocky derivatives)
        float rt=uTime, h0=rip(p,rt), hx=rip(p+vec2(.15,0.),rt), hz=rip(p+vec2(0.,.15),rt);
        ripN=vec2(h0-hx,h0-hz)*(1.-smoothstep(25.,140.,dist))*.35;   // calm water: gentle ripples
        diffuseColor.a=1.;`)
      .replace('#include <roughnessmap_fragment>',`#include <roughnessmap_fragment>
        roughnessFactor=mix(.95,.12,openK);`)
      .replace('#include <metalnessmap_fragment>',`#include <metalnessmap_fragment>
        metalnessFactor=0.;`)
      .replace('#include <normal_fragment_begin>',`#include <normal_fragment_begin>
        // rain (Claude Code): rings spreading from the drops on the open water, close up (as on the rivers, shaders.js)
        float rainK=uWeather.y*(1.-smoothstep(20.,60.,dist))*openK;
        if(rainK>.01){
          for(int k=0;k<2;k++){
            vec2 rp=vPhotoWorld.xz/(k==0?.7:1.13)+float(k)*7.3,ci=floor(rp),cf=fract(rp)-.5;
            float t=fract(uTime*.85+wh(ci+float(k)*31.));
            vec2 d=cf-(vec2(wh(ci+3.1),wh(ci+7.7))-.5)*.5;
            float r=length(d),front=r-t*.42,ring=sin(front*46.)*exp(-front*front/.0036)*(1.-t);
            vec2 dir=d/max(r,1e-4);
            ripN+=dir*ring*.45*rainK;
          }
        }
        normal=normalize(normal+(viewMatrix*vec4(ripN.x,0.,ripN.y,0.)).xyz*openK);`)
      .replace('#include <opaque_fragment>',`
        if(openK>.01){
          vec3 wN=normalize(transpose(mat3(viewMatrix))*normal);
          vec3 wV=normalize(cameraPosition-vPhotoWorld);
          float NdV=max(dot(wN,wV),.05), Fr=.02+.98*pow(1.-NdV,5.);
          vec3 R=reflect(-wV,wN); R.y=max(R.y,.01);
          float cloudC;
          vec3 skyR=skyRadiance(normalize(R),vPhotoWorld,1.,cloudC)*mix(1.,.18,cover.g);   // the canopy hides most sky
          skyR=mix(skyR,vec3(.03,.05,.025),cover.g*.5);
          if(uRefl.x>.5){                                         // mirrored trunks, boats, canopy
            vec4 rc=uReflMatrix*vec4(vPhotoWorld.x,uRefl.y,vPhotoWorld.z,1.);
            float rk=(1.-smoothstep(uRefl.z*.6,uRefl.z,dist))*(1.-smoothstep(.5,3.,abs(vPhotoWorld.y-uRefl.y)));
            if(rc.w>0.&&rk>0.){
              vec4 mir=texture2D(uReflMap,clamp(rc.xy/rc.w+wN.xz*.06,vec2(.001),vec2(.999)));
              skyR=mix(skyR,mir.rgb,mir.a*rk);
            }
          }
          vec3 glint=vec3(0.);
          #if NUM_DIR_LIGHTS > 0
            vec3 H=normalize(wV+uSunDir);
            float c=max(dot(wN,H),1e-3),c2=c*c,s2=.004;
            float D=exp((c2-1.)/(c2*s2))/(PI*s2*c2*c2);
            glint=directLight.color*D*(.02+.98*pow(1.-max(dot(wV,H),0.),5.))/(4.*NdV)*(1.-cover.g*.7);
          #endif
          vec3 waterLit=(reflectedLight.directDiffuse+reflectedLight.indirectDiffuse)*(1.-Fr)+skyR*max(Fr,.35)+glint;
          outgoingLight=mix(outgoingLight,waterLit,openK);
        }
        #include <opaque_fragment>`);
    patchCloudShadow(sh,skyUniforms());
  };
  // Supply UV varying even without a conventional map (Three otherwise omits vUv).
  mat.defines={USE_UV:''};mat.customProgramCacheKey=()=> 'trasu-water-duckweed-v6';return mat;
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
    this.built=false;this.nearMeshes=[];this.boats=[];
    this.views=this.makeViews();
  }
  makeViews() {
    const m=this.map,c=m.centre,p=pathPoint(m.data.channels[0].points,.49),q=pathPoint(m.data.channels[0].points,.478);
    const V=(x,y,z)=>new THREE.Vector3(c[0]+x,y,c[1]+z);
    return {trasu:{target:V(200,m.level+10,200),pos:V(1250,m.level+720,1380)},
            trasuCanal:{target:V(q.x,m.level+2.4,q.z),pos:V(p.x,m.level+2.6,p.z)},
            trasuBirds:{target:V(-242,m.level+13.0,204),pos:V(-217,m.level+16.0,237)}};
  }
  async build(local) {
    const m=this.map,[l,t,r,b]=m.data.bounds,texture=await new THREE.TextureLoader().loadAsync('data/trasu-cover.png');
    texture.colorSpace=THREE.NoColorSpace;texture.anisotropy=4;
    const water=new THREE.Mesh(new THREE.PlaneGeometry(r-l,b-t),waterMaterial(texture,m,this.shared.uTime));
    water.rotation.x=-Math.PI/2;water.position.set((l+r)/2,m.level+.025,(t+b)/2);water.userData.noShadow=true;water.receiveShadow=true;this.content.add(water);
    this.forest=new TraSuForest(this);await this.forest.load();
    this.buildBoardwalk();
    const proto=sampan();
    for(let i=0;i<9;i++){const boat=proto.clone();this.boats.push({mesh:boat,phase:i===0?.483:(i+.3)/10,moored:i===0,dir:i%2?-1:1});this.boatGroup.add(boat);}
    this.built=true;
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
  update(camera) {
    const local=camera.position.clone().sub(this.group.position),near=Math.hypot(local.x,local.z)<5200 && camera.position.y<5000;
    if(!this.group.visible)return;
    this.content.visible=near;
    if(!near)return;
    // Child layer visibility is controlled independently by the main UI.
    if(!this.built){if(!this.building)this.building=this.build(local).catch(e=>console.warn('Trà Sư detail unavailable',e));return;}
    this.forest.update(camera);
    this.detail.visible=true;                  // canopy birds remain visible from the air; plants have their own range
    const time=this.shared.uTime.value;
    for(const b of this.boats){const t=b.moored?b.phase+.001*Math.sin(time*.06):(b.phase+b.dir*time*.00014+10)%1,p=pathPoint(this.map.data.channels[0].points,t);
      b.mesh.position.set(p.x,this.map.level+Math.sin(time*.9+b.phase*10)*.018,p.z);b.mesh.rotation.y=p.angle+(b.dir<0?Math.PI:0);b.mesh.visible=this.map.sampleLocal(p.x,p.z)>.95;}
  }
}
