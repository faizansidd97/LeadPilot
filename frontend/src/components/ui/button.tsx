import {Slot} from '@radix-ui/react-slot';
import {cva,type VariantProps} from 'class-variance-authority';
import type {ComponentProps} from 'react';
import {cn} from '@/lib/utils';
const buttonVariants=cva('inline-flex items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50',{variants:{variant:{default:'border-transparent bg-[#266d57] text-white hover:bg-[#1f5948]',outline:'border-[#e4e9e5] bg-white text-[#172c2a] hover:bg-[#edf3ee]',ghost:'border-transparent bg-transparent text-[#266d57] hover:bg-[#edf3ee]'}},defaultVariants:{variant:'default'}});
export function Button({asChild=false,variant,className,type='button',...props}:ComponentProps<'button'>&VariantProps<typeof buttonVariants>&{asChild?:boolean}){const Component=asChild?Slot:'button';return <Component type={type} className={cn(buttonVariants({variant}),className)} {...props}/>;}
