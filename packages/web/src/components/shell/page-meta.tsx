import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DependencyList,
  type ReactNode,
} from 'react';
import type { Breadcrumb } from '@/lib/nav';

/**
 * What the page tells the frame about itself.
 *
 * The header used to derive its title from an if-chain over `pathname`
 * (`App.tsx`'s `pageTitle`), which meant every new route had to be taught to
 * a function three files away and detail pages could never name the record
 * they show. Now the shell asks `ROUTE_META` for the default chain and the
 * page overrides only what it alone knows.
 */
export interface PageMeta {
  /**
   * Replaces the last breadcrumb label - a conversation title, an agent's
   * name. Everything above it still comes from `ROUTE_META`.
   */
  title?: string;
  /** The whole chain, for the rare page whose ancestry is not its route. */
  breadcrumb?: Breadcrumb[];
  /** Buttons for the right-hand side of the header. */
  actions?: ReactNode;
}

interface PageMetaStore {
  meta: PageMeta;
  /**
   * `null` withdraws the page's meta again. The owner token makes that safe
   * during a route change: the new page publishes before the old one's
   * cleanup runs, and a cleanup that no longer owns the slot does nothing.
   */
  publish(owner: object, meta: PageMeta | null): void;
}

const EMPTY: PageMeta = {};

const PageMetaContext = createContext<PageMetaStore | null>(null);

export function PageMetaProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<PageMeta>(EMPTY);
  const ownerRef = useRef<object | null>(null);

  const publish = useCallback((owner: object, next: PageMeta | null) => {
    if (next === null) {
      if (ownerRef.current !== owner) return;
      ownerRef.current = null;
      setMeta(EMPTY);
      return;
    }
    ownerRef.current = owner;
    setMeta(next);
  }, []);

  // The value identity has to change on every publish: `children` is a stable
  // element, so a plain re-render of this provider would be bailed out of and
  // the header would never see the new meta.
  const value = useMemo<PageMetaStore>(() => ({ meta, publish }), [meta, publish]);

  return <PageMetaContext.Provider value={value}>{children}</PageMetaContext.Provider>;
}

function useStore(): PageMetaStore {
  const store = useContext(PageMetaContext);
  if (!store) throw new Error('usePageMeta must be used within a PageMetaProvider');
  return store;
}

/**
 * Declare what the header shows while this page is mounted. Call it once per
 * page, near the top.
 *
 * By default the meta is republished whenever the title or the breadcrumb
 * text changes; anything else the page puts in `actions` is read fresh at
 * that moment. An action row that has to react to something else - a pending
 * flag, a loaded record - names it in `deps`, exactly like `useEffect`.
 */
export function usePageMeta(meta: PageMeta, deps: DependencyList = []): void {
  const { publish } = useStore();

  // Read through a ref so the effect below can stay on its declared deps
  // without capturing a stale `actions` node.
  const metaRef = useRef(meta);
  metaRef.current = meta;

  // One stable identity per mounted page, to tell two pages apart while they
  // overlap during a route change.
  const owner = useRef({}).current;

  const key =
    (meta.title ?? '') +
    '|' +
    (meta.breadcrumb?.map((crumb) => crumb.label + '>' + (crumb.to ?? '')).join('/') ?? '');

  useLayoutEffect(() => {
    publish(owner, metaRef.current);
    return () => publish(owner, null);
    // `deps` has a fixed length per call site, so spreading it is safe here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publish, owner, key, ...deps]);
}

/** What the header renders. Empty while no page has published anything. */
export function usePageMetaValue(): PageMeta {
  return useStore().meta;
}
