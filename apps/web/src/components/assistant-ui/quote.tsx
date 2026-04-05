import { memo, type ComponentProps, type FC } from 'react'
import type { QuoteMessagePartComponent } from '@assistant-ui/react'
import { ComposerPrimitive, SelectionToolbarPrimitive } from '@assistant-ui/react'
import { QuoteIcon, XIcon } from 'lucide-react'
import { cn } from '../../lib/utils'

function QuoteBlockRoot({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div data-slot="quote-block" className={cn('mb-2 flex items-start gap-1.5', className)} {...props} />
}

function QuoteBlockIcon({ className, ...props }: ComponentProps<typeof QuoteIcon>): JSX.Element {
  return (
    <QuoteIcon
      data-slot="quote-block-icon"
      className={cn('mt-0.5 size-3 shrink-0 text-muted-foreground/60', className)}
      {...props}
    />
  )
}

function QuoteBlockText({ className, ...props }: ComponentProps<'p'>): JSX.Element {
  return (
    <p
      data-slot="quote-block-text"
      className={cn('line-clamp-2 min-w-0 text-sm italic text-muted-foreground/80', className)}
      {...props}
    />
  )
}

const QuoteBlockImpl: QuoteMessagePartComponent = ({ text }) => {
  return (
    <QuoteBlockRoot>
      <QuoteBlockIcon />
      <QuoteBlockText>{text}</QuoteBlockText>
    </QuoteBlockRoot>
  )
}

const QuoteBlock = memo(QuoteBlockImpl) as QuoteMessagePartComponent & {
  Root: typeof QuoteBlockRoot
  Icon: typeof QuoteBlockIcon
  Text: typeof QuoteBlockText
}

QuoteBlock.displayName = 'QuoteBlock'
QuoteBlock.Root = QuoteBlockRoot
QuoteBlock.Icon = QuoteBlockIcon
QuoteBlock.Text = QuoteBlockText

function SelectionToolbarRoot({
  className,
  ...props
}: ComponentProps<typeof SelectionToolbarPrimitive.Root>): JSX.Element {
  return (
    <SelectionToolbarPrimitive.Root
      data-slot="selection-toolbar"
      className={cn('flex items-center gap-1 rounded-lg border bg-popover px-1 py-1 shadow-md', className)}
      {...props}
    />
  )
}

function SelectionToolbarQuote({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectionToolbarPrimitive.Quote>): JSX.Element {
  return (
    <SelectionToolbarPrimitive.Quote
      data-slot="selection-toolbar-quote"
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm text-popover-foreground transition-colors hover:bg-accent',
        className
      )}
      {...props}
    >
      {children ?? (
        <>
          <QuoteIcon className="size-3.5" />
          Quote
        </>
      )}
    </SelectionToolbarPrimitive.Quote>
  )
}

const SelectionToolbarImpl: FC<ComponentProps<typeof SelectionToolbarRoot>> = ({
  className,
  ...props
}) => {
  return (
    <SelectionToolbarRoot className={className} {...props}>
      <SelectionToolbarQuote />
    </SelectionToolbarRoot>
  )
}

const SelectionToolbar = memo(SelectionToolbarImpl) as typeof SelectionToolbarImpl & {
  Root: typeof SelectionToolbarRoot
  Quote: typeof SelectionToolbarQuote
}

SelectionToolbar.displayName = 'SelectionToolbar'
SelectionToolbar.Root = SelectionToolbarRoot
SelectionToolbar.Quote = SelectionToolbarQuote

function ComposerQuotePreviewRoot({
  className,
  ...props
}: ComponentProps<typeof ComposerPrimitive.Quote>): JSX.Element {
  return (
    <ComposerPrimitive.Quote
      data-slot="composer-quote"
      className={cn('mx-3 mt-2 flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2', className)}
      {...props}
    />
  )
}

function ComposerQuotePreviewIcon({
  className,
  ...props
}: ComponentProps<typeof QuoteIcon>): JSX.Element {
  return (
    <QuoteIcon
      data-slot="composer-quote-icon"
      className={cn('mt-0.5 size-3.5 shrink-0 text-muted-foreground/70', className)}
      {...props}
    />
  )
}

function ComposerQuotePreviewText({
  className,
  ...props
}: ComponentProps<typeof ComposerPrimitive.QuoteText>): JSX.Element {
  return (
    <ComposerPrimitive.QuoteText
      data-slot="composer-quote-text"
      className={cn('line-clamp-2 min-w-0 flex-1 text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

function ComposerQuotePreviewDismiss({
  className,
  children,
  ...props
}: ComponentProps<typeof ComposerPrimitive.QuoteDismiss>): JSX.Element {
  const defaultClassName =
    'shrink-0 rounded-sm p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground'

  return (
    <ComposerPrimitive.QuoteDismiss
      data-slot="composer-quote-dismiss"
      asChild
      className={children ? className : undefined}
      {...props}
    >
      {children ?? (
        <button type="button" aria-label="Dismiss quote" className={cn(defaultClassName, className)}>
          <XIcon className="size-3.5" />
        </button>
      )}
    </ComposerPrimitive.QuoteDismiss>
  )
}

const ComposerQuotePreviewImpl: FC<ComponentProps<typeof ComposerQuotePreviewRoot>> = ({
  className,
  ...props
}) => {
  return (
    <ComposerQuotePreviewRoot className={className} {...props}>
      <ComposerQuotePreviewIcon />
      <ComposerQuotePreviewText />
      <ComposerQuotePreviewDismiss />
    </ComposerQuotePreviewRoot>
  )
}

const ComposerQuotePreview = memo(ComposerQuotePreviewImpl) as typeof ComposerQuotePreviewImpl & {
  Root: typeof ComposerQuotePreviewRoot
  Icon: typeof ComposerQuotePreviewIcon
  Text: typeof ComposerQuotePreviewText
  Dismiss: typeof ComposerQuotePreviewDismiss
}

ComposerQuotePreview.displayName = 'ComposerQuotePreview'
ComposerQuotePreview.Root = ComposerQuotePreviewRoot
ComposerQuotePreview.Icon = ComposerQuotePreviewIcon
ComposerQuotePreview.Text = ComposerQuotePreviewText
ComposerQuotePreview.Dismiss = ComposerQuotePreviewDismiss

export {
  QuoteBlock,
  SelectionToolbar,
  ComposerQuotePreview,
  QuoteBlockRoot,
  QuoteBlockIcon,
  QuoteBlockText,
  SelectionToolbarRoot,
  SelectionToolbarQuote,
  ComposerQuotePreviewRoot,
  ComposerQuotePreviewIcon,
  ComposerQuotePreviewText,
  ComposerQuotePreviewDismiss
}
