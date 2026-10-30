// The network and studio pages' routes on Home's stack (src/app/(tabs)/home/network/[id].tsx and studio/[id].tsx): the
// address's ID, checked, or Not found without a call; a network's list from `?kind=` (series or films; anything else
// is All), as the PWA's `#/network/:id?kind=`. And a Discover row's See all page (home/list/[list].tsx): only a list
// one of Home's rows shows, else Not found without a call.
import { useLocalSearchParams } from 'expo-router';

import { seeAllRow } from '../home/layout';
import type { SourceList } from '../home/text';
import { routeNumber } from '../title/route';
import { ListScreen } from './ListScreen';
import { NotFoundScreen } from './NotFoundScreen';
import { SourceScreen } from './SourceScreen';

export function StudioRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const studio = routeNumber(id);
  return studio === undefined ? <NotFoundScreen /> : <SourceScreen key={studio} kind="studio" id={studio} list="all" />;
}

export function NetworkRoute() {
  const { id, kind } = useLocalSearchParams<{ id: string; kind?: string }>();
  const network = routeNumber(id);
  const list: SourceList = kind === 'series' || kind === 'films' ? kind : 'all';
  // Keyed by the network alone: choosing a tab changes `kind` in place, and the page keeps what it has.
  return network === undefined ? <NotFoundScreen /> : <SourceScreen key={network} kind="network" id={network} list={list} />;
}

export function ListRoute() {
  const { list } = useLocalSearchParams<{ list: string }>();
  const row = seeAllRow(list);
  return row === undefined ? <NotFoundScreen /> : <ListScreen key={row.list} row={row} />;
}
