import type { Meta, StoryObj } from '@storybook/react-vite';
import { InstallButton } from './InstallButton';

const meta: Meta<typeof InstallButton> = {
  component: InstallButton,
  args: {
    slug: 'example-plugin',
    onInstall: async () => ({ ok: true, projectSlug: 'example-plugin' }),
  },
};
export default meta;

type Story = StoryObj<typeof InstallButton>;

export const NotInstalled: Story = {};

export const AlreadyInstalled: Story = {
  args: { alreadyInstalled: true },
};

export const MultiTopologySingleSubproject: Story = {
  args: {
    topology: 'multi',
    subprojects: [{ suffix: 'web', kind: 'web' }],
  },
};

export const MultiTopologyMultipleSubprojects: Story = {
  args: {
    topology: 'multi',
    subprojects: [
      { suffix: 'web', kind: 'web' },
      { suffix: 'api', kind: 'api' },
      { suffix: 'worker', kind: 'worker', department_slug: 'backend' },
    ],
  },
};
