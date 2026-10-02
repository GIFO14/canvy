import { reactive } from 'vue';

// Review state belongs to this panel, never to the design checkpoint.
export const interaction = reactive({ mode: 'interact', spacePan: false });
