import { mount } from 'svelte';
import Embed from './Embed.svelte';

const app = mount(Embed, {
  target: document.getElementById('embed'),
});

export default app;
