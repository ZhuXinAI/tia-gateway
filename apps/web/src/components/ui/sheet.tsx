import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { cn } from '../../lib/utils'

export const Sheet = DialogPrimitive.Root
export const SheetTrigger = DialogPrimitive.Trigger

export function SheetContent({
  className,
  side = 'right',
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  side?: 'top' | 'right' | 'bottom' | 'left'
}): JSX.Element {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30" />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 flex flex-col border bg-background shadow-lg transition',
          side === 'left' && 'inset-y-0 left-0 h-full w-80',
          side === 'right' && 'inset-y-0 right-0 h-full w-80',
          side === 'top' && 'inset-x-0 top-0 h-auto',
          side === 'bottom' && 'inset-x-0 bottom-0 h-auto',
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute top-3 right-3 rounded-sm p-1 text-muted-foreground hover:bg-muted">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}
