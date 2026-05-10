import type { Preview } from '@storybook/react-vite';
import '../src/styles.css';

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: 'site',
      values: [
        { name: 'site',  value: '#0c0e16' },
        { name: 'light', value: '#ffffff' },
      ],
    },
    layout: 'fullscreen',
  },
};

export default preview;
