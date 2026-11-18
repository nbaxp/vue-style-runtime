import{ref as a,shallowRef as O,watch as C,computed as D,createApp as S,onMounted as U,onBeforeUnmount as _,compile as $}from"https://esm.sh/vue@3.5.44/dist/vue.esm-browser.js";(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const r of document.querySelectorAll('link[rel="modulepreload"]'))n(r);new MutationObserver(r=>{for(const o of r)if(o.type==="childList")for(const p of o.addedNodes)p.tagName==="LINK"&&p.rel==="modulepreload"&&n(p)}).observe(document,{childList:!0,subtree:!0});function s(r){const o={};return r.integrity&&(o.integrity=r.integrity),r.referrerPolicy&&(o.referrerPolicy=r.referrerPolicy),r.crossOrigin==="use-credentials"?o.credentials="include":r.crossOrigin==="anonymous"?o.credentials="omit":o.credentials="same-origin",o}function n(r){if(r.ep)return;r.ep=!0;const o=s(r);fetch(r.href,o)}})();const g=new URL("./index.js",location.href).href,L=new URL("./demo-child.js",location.href).href,b=`import styleMixin from '${g}';

export default {
  name: 'DemoCard',
  mixins: [styleMixin],
  template: \`
    <div class="demo-card">
      <h3 class="demo-card__title">scoped 样式实时改写</h3>
      <p class="demo-card__text">
        修改左侧的组件对象，右栏会重新挂载组件；
        下方可以看到 head 中改写后的真实 CSS。
      </p>
    </div>
  \`,
  styles: \`
    <style scoped>
    .demo-card {
      border: 1px solid #93c5fd;
      background: #eff6ff;
      border-radius: 8px;
      padding: 14px 16px;
    }
    .demo-card__title {
      margin: 0 0 6px;
      color: #1d4ed8;
    }
    .demo-card__text {
      margin: 0;
      color: #3b82f6;
    }
    </style>
  \`,
};`,M=`import styleMixin from '${g}';
import DemoChild from '${L}';

export default {
  name: 'DemoDeep',
  mixins: [styleMixin],
  components: { DemoChild },
  template: \`
    <div class="demo-deep">
      父组件用 :deep(.demo-badge) 改写子组件内部 badge：
      <demo-child></demo-child>
    </div>
  \`,
  styles: \`
    <style scoped>
    .demo-deep {
      border: 1px dashed #f59e0b;
      border-radius: 8px;
      padding: 14px 16px;
    }
    .demo-deep :deep(.demo-badge) {
      background: #fef3c7;
      color: #b45309;
    }
    </style>
  \`,
};`,T=`import styleMixin from '${g}';

export default {
  name: 'DemoSlot',
  mixins: [styleMixin],
  template: \`
    <div class="demo-slot">
      子组件内部区域：<slot></slot>
    </div>
  \`,
  styles: \`
    <style scoped>
    .demo-slot {
      border: 1px dashed #10b981;
      border-radius: 8px;
      padding: 14px 16px;
      color: #065f46;
    }
    :slotted(.slot-item) {
      background: #d1fae5;
      border-radius: 6px;
      padding: 2px 10px;
    }
    </style>
  \`,
};`;async function A(e){const t=`data:text/javascript;charset=utf-8,${encodeURIComponent(e)}`;let s;try{s=await import(t)}catch(n){throw new Error(`模块执行失败：${n.message||n}`)}return s.default}async function P(e){const t=await A(e);if(!t||typeof t!="object")throw new Error("模块需要 export default 组件对象");if(typeof t.template!="string"||!t.template.trim())throw new Error("template 必须是非空字符串");if(typeof t.styles!="string"||!t.styles.trim())throw new Error("styles 必须是非空字符串（本库不接受数组）");try{$(t.template)}catch(s){throw new Error(`模板编译失败：${s.message||s}`)}return t}const l=a(b),w=O(null),y=a(0),u=a(!0),i=a(""),x=a([]);let c,m,h=!1,f=0;async function d(){clearTimeout(c);const e=++f;try{const t=await P(l.value);if(e!==f)return;w.value=t,y.value+=1,i.value=""}catch(t){if(e!==f)return;i.value=t?.message||String(t)}}C(l,()=>{if(h){h=!1;return}clearTimeout(c),c=setTimeout(d,280)});function R(e){h=!0,l.value=e,d()}function v(){x.value=Array.from(document.head.querySelectorAll("style[data-vue-component-instances]")).map(e=>({name:e.className,count:e.getAttribute("data-vue-component-instances"),scope:e.getAttribute("data-vue-style-scoped")??"非 scoped",css:e.textContent.trim().replace(/\s+/g," ")}))}const j=D(()=>x.value.map(e=>`/* ${e.name} · 实例数 ${e.count} · ${e.scope} */
${e.css}`).join(`

`)),E=S({setup(){return U(()=>{v(),m=new MutationObserver(v),m.observe(document.head,{childList:!0,subtree:!0,attributes:!0,characterData:!0})}),_(()=>{clearTimeout(c),m?.disconnect()}),{source:l,view:w,revision:y,previewOn:u,error:i,injected:x,styleDump:j,loadPreset:R,apply:d,remount(){y.value+=1},togglePreview(){u.value=!u.value},presets:{basic:b,deep:M,slotted:T}}}});E.config.errorHandler=e=>{i.value=e?.message||String(e)};E.mount("#app");d();
