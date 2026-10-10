'use client';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {X} from 'lucide-react';
import type {ComponentProps} from 'react';
import {cn} from '@/lib/utils';
export const Dialog=DialogPrimitive.Root;
export const DialogTitle=DialogPrimitive.Title;
export const DialogDescription=DialogPrimitive.Description;
export const DialogTrigger=DialogPrimitive.Trigger;
export function DialogContent({children,className,showClose=true,closeDisabled=false,...props}:ComponentProps<typeof DialogPrimitive.Content>&{showClose?:boolean;closeDisabled?:boolean}){return <DialogPrimitive.Portal><DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40"/><DialogPrimitive.Content className={cn('fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-white p-6 shadow-xl outline-none',className)} {...props}>{children}{showClose&&<DialogPrimitive.Close disabled={closeDisabled} className="absolute right-4 top-4 rounded-md border-0 bg-white p-2" aria-label="Close dialog"><X size={18}/></DialogPrimitive.Close>}</DialogPrimitive.Content></DialogPrimitive.Portal>;}
