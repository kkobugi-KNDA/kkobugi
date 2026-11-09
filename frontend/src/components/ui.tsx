import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Inbox, type LucideIcon } from 'lucide-react';

export function PageHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}
export function Badge({
  tone = 'slate',
  children,
}: {
  tone?: 'slate' | 'blue' | 'green' | 'amber' | 'red';
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={25} strokeWidth={1.5} />
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}
function Overlay({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className = '',
  drawer,
}: OverlayProps & { drawer?: boolean }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-backdrop" />
        <Dialog.Content
          className={`${drawer ? 'drawer' : 'modal'} ${className}`}
          aria-describedby={description ? undefined : ''}
        >
          <header className="overlay-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && <Dialog.Description>{description}</Dialog.Description>}
            </div>
            <Dialog.Close asChild>
              <button className="icon-button" aria-label="창 닫기">
                <X size={19} />
              </button>
            </Dialog.Close>
          </header>
          <div className="overlay-content">{children}</div>
          {footer && <footer className="overlay-footer">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export const Modal = (props: OverlayProps) => <Overlay {...props} />;
export const Drawer = (props: OverlayProps) => <Overlay {...props} drawer />;
export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="field-hint">{hint}</p>
      )}
    </div>
  );
}
export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning' | 'error' | 'success';
  children: ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      {children}
    </div>
  );
}
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}
