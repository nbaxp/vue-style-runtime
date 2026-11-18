import {
  createApp,
  compile,
  ref,
  shallowRef,
  watch,
  computed,
  onMounted,
  onBeforeUnmount,
} from 'vue/dist/vue.esm-bundler.js';

// 源码以 data: 模块执行，模块内无法解析相对说明符，
// 所以示例里写带 origin 的绝对地址；dev 下指向源码，preview/gh-pages 下指向 dist 产物。
const libraryUrl = new URL('./index.js', location.href).href;

// 一个示例同时覆盖三类改写：基础 scoped、:deep 穿透、:slotted 插槽。
const EXAMPLE_SOURCE = `import styleMixin from '${libraryUrl}';

const DemoChild = {
  name: 'DemoChild',
  mixins: [styleMixin],
  styles: \`
    <style scoped>
      .demo-badge {
        display: inline-block;
        background: #dbeafe;
        color: #1d4ed8;
        border-radius: 999px;
        padding: 2px 10px;
      }
    </style>
  \`,
  template: \`<span class="demo-badge">子组件内部 badge</span>\`,
};

export default {
  name: 'DemoExample',
  mixins: [styleMixin],
  components: { DemoChild },
  template: \`
    <div class="demo-root">
      <p class="demo-text">这段文字与边框来自基础 scoped 样式。</p>
      <p>子组件 badge 被父组件 :deep(.demo-badge) 改写：<demo-child></demo-child></p>
      <p>插槽内容被 :slotted(.slot-item) 改写：<slot></slot></p>
    </div>
  \`,
  styles: \`
    <style scoped>
    .demo-root {
      border: 1px dashed #93c5fd;
      border-radius: 8px;
      padding: 14px 16px;
    }
    .demo-text {
      margin: 0 0 8px;
      color: #1d4ed8;
    }
    .demo-root :deep(.demo-badge) {
      background: #fef3c7;
      color: #b45309;
    }
    :slotted(.slot-item) {
      background: #d1fae5;
      border-radius: 6px;
      padding: 2px 10px;
    }
    </style>
  \`,
};`;

// 左侧源码就是右侧真正执行的模块：原样编码成 data: URL 后 import，不做字符串改写。
async function importComponent(source) {
  const dataUri = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;

  let module;

  try {
    module = await import(/* @vite-ignore */ dataUri);
  } catch (error) {
    throw new Error(`模块执行失败：${error.message || error}`);
  }

  return module.default;
}

async function createComponent(source) {
  const component = await importComponent(source);

  if (!component || typeof component !== 'object') {
    throw new Error('模块需要 export default 组件对象');
  }

  if (typeof component.template !== 'string' || !component.template.trim()) {
    throw new Error('template 必须是非空字符串');
  }

  if (typeof component.styles !== 'string' || !component.styles.trim()) {
    throw new Error('styles 必须是非空字符串（本库不接受数组）');
  }

  try {
    compile(component.template);
  } catch (error) {
    throw new Error(`模板编译失败：${error.message || error}`);
  }

  return component;
}

const source = ref(EXAMPLE_SOURCE);
const view = shallowRef(null);
const revision = ref(0);
const error = ref('');
const injected = ref([]);

let timer;
let observer;
let skipWatch = false;
let applyToken = 0;

async function apply() {
  clearTimeout(timer);

  const token = ++applyToken;

  try {
    const component = await createComponent(source.value);

    // 连续编辑时只认最后一次成功的结果。
    if (token !== applyToken) return;

    view.value = component;
    revision.value += 1;
    error.value = '';
  } catch (err) {
    if (token !== applyToken) return;

    error.value = err?.message || String(err);
  }
}

watch(source, () => {
  if (skipWatch) {
    skipWatch = false;
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(apply, 280);
});

function resetExample() {
  skipWatch = true;
  source.value = EXAMPLE_SOURCE;
  apply();
}

function refresh() {
  injected.value = Array.from(
    document.head.querySelectorAll('style[data-vue-component-instances]'),
  ).map((node) => ({
    name: node.className,
    count: node.getAttribute('data-vue-component-instances'),
    scope: node.getAttribute('data-vue-style-scoped') ?? '非 scoped',
    css: node.textContent.trim().replace(/\s+/g, ' '),
  }));
}

const styleDump = computed(() =>
  injected.value
    .map(
      (item) =>
        `/* ${item.name} · 实例数 ${item.count} · ${item.scope} */\n${item.css}`,
    )
    .join('\n\n'),
);

const app = createApp({
  setup() {
    onMounted(() => {
      refresh();
      observer = new MutationObserver(refresh);
      observer.observe(document.head, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    });

    onBeforeUnmount(() => {
      clearTimeout(timer);
      observer?.disconnect();
    });

    return {
      source,
      view,
      revision,
      error,
      injected,
      styleDump,
      resetExample,
    };
  },
});

app.config.errorHandler = (err) => {
  error.value = err?.message || String(err);
};
app.mount('#app');
apply();
