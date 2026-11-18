import {
  createApp,
  compile,
  ref,
  shallowRef,
  watch,
  computed,
  onMounted,
  onBeforeUnmount,
} from 'https://esm.sh/vue@3.5.44/dist/vue.esm-browser.js';

// 源码以 data: 模块执行，模块内无法解析相对说明符，
// 所以预设里写带 origin 的绝对地址；dev 下指向源码，preview/gh-pages 下指向 dist 产物。
const libraryUrl = new URL('./index.js', location.href).href;
const childUrl = new URL('./demo-child.js', location.href).href;

const DEFAULT_SOURCE = `import styleMixin from '${libraryUrl}';

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
};`;

const DEEP_SOURCE = `import styleMixin from '${libraryUrl}';
import DemoChild from '${childUrl}';

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
};`;

const SLOTTED_SOURCE = `import styleMixin from '${libraryUrl}';

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

const source = ref(DEFAULT_SOURCE);
const view = shallowRef(null);
const revision = ref(0);
const previewOn = ref(true);
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

function loadPreset(text) {
  skipWatch = true;
  source.value = text;
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
      previewOn,
      error,
      injected,
      styleDump,
      loadPreset,
      apply,
      remount() {
        revision.value += 1;
      },
      togglePreview() {
        previewOn.value = !previewOn.value;
      },
      presets: {
        basic: DEFAULT_SOURCE,
        deep: DEEP_SOURCE,
        slotted: SLOTTED_SOURCE,
      },
    };
  },
});

app.config.errorHandler = (err) => {
  error.value = err?.message || String(err);
};
app.mount('#app');
apply();
