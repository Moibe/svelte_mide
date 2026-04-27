import { mount } from 'svelte';
import ContextLightEmbed from './ContextLightEmbed.svelte';

const app = mount(ContextLightEmbed, {
  target: document.getElementById('embed'),
});

export default app;
