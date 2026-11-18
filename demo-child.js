import styleMixin from './index.js';

export default {
  name: 'DemoChild',
  mixins: [styleMixin],
  styles: `
    <style scoped>
      .demo-badge {
        display: inline-block;
        background: #dbeafe;
        color: #1d4ed8;
        border-radius: 999px;
        padding: 2px 10px;
      }
    </style>
  `,
  template: `<span class="demo-badge">子组件内部 badge</span>`,
};
