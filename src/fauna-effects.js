// Surface-only rings and spray: original quads above water; no water-shader dependency.
import * as THREE from 'three';
export class FaunaEffects {
  constructor(mobile){
    const g=new THREE.PlaneGeometry(1,1,2,2);g.rotateX(-Math.PI/2);
    this.events=new THREE.InstancedBufferAttribute(new Float32Array((mobile?8:48)*2),2);g.setAttribute('aEvent',this.events);
    const mat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,
      vertexShader:`attribute vec2 aEvent; varying vec2 vUv; varying vec2 vEvent;
      void main(){vUv=uv;vEvent=aEvent;vec3 p=position;p.y+=vEvent.y*.45*max(0.,1.-vEvent.x*5.)*exp(-length(p.xz)*18.);gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(p,1.);}`,
      fragmentShader:`varying vec2 vUv;varying vec2 vEvent;
      void main(){float d=length(vUv-.5)*2.;float ring=exp(-pow((d-(.14+vEvent.x*.76))/.022,2.));
      float second=exp(-pow((d-(.04+vEvent.x*.55))/.018,2.))*.45;
      float spray=exp(-d*20.)*max(0.,1.-vEvent.x*5.)*vEvent.y;
      float a=(ring+second+spray)*(1.-vEvent.x)*.48;if(a<.015)discard;
      gl_FragColor=vec4(.63,.66,.53,a); #include <tonemapping_fragment>
      #include <colorspace_fragment>}`});
    // Shader includes must start on their own line.
    mat.fragmentShader=mat.fragmentShader.replace('; #include',';\n#include');
    this.mesh=new THREE.InstancedMesh(g,mat,mobile?8:48);this.mesh.name='fauna-surface-rings';this.mesh.count=0;
    this.mesh.frustumCulled=false;this.mesh.userData.noShadow=true;this.mesh.userData.noReflect=true;this.mesh.userData.fauna=true;
    this.capacity=mobile?8:48;this.dummy=new THREE.Object3D();this.count=0;
  }
  reset(){this.count=0;}
  emit(x,h,n,t,splash=0){
    if(this.count>=this.capacity)return;const i=this.count++;this.dummy.position.set(x,h+.045,-n);
    this.dummy.scale.setScalar(splash?2:1.1);this.dummy.updateMatrix();this.mesh.setMatrixAt(i,this.dummy.matrix);this.events.setXY(i,t,splash);
  }
  finish(){this.mesh.count=this.count;this.mesh.visible=this.count>0;if(this.count){this.mesh.instanceMatrix.needsUpdate=true;this.events.needsUpdate=true;}}
  dispose(){this.mesh.geometry.dispose();this.mesh.material.dispose();this.mesh.dispose();}
}
