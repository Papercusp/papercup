import type { Meta, StoryObj } from '@storybook/react-vite';
import { SiteHeader } from './SiteHeader';

const meta: Meta<typeof SiteHeader> = {
  component: SiteHeader,
};
export default meta;

type Story = StoryObj<typeof SiteHeader>;

export const Default: Story = {};

export const NoCta: Story = { args: { cta: null } };

export const CustomCta: Story = {
  args: { cta: { href: '#', label: 'Open Operator' } },
};

export const ShortNav: Story = {
  args: {
    navLinks: [
      { href: '/marketplace/', label: 'Marketplace' },
      { href: '/docs', label: 'Docs' },
    ],
  },
};

export const NoExternalLinks: Story = {
  args: {
    navLinks: [
      { href: '/marketplace/', label: 'Marketplace' },
      { href: '/docs', label: 'Docs' },
      { href: '/support', label: 'Support' },
    ],
  },
};
