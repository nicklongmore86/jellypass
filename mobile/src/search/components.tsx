// Search's pieces, the PWA's (app/src/render.ts) in the Tidepool look: the squircle field with its magnifier, the
// poster grid and its skeleton, and the Load more button. Text grows with the system font size with no line limit,
// cap or fixed height: the field and the cards grow with it.
import { StyleSheet, TextInput, View } from 'react-native';

import type { Card } from '../api/types';
import { PosterCard } from '../home/components';
import { Icon } from '../icons';
import { colors, layout, radii, typography } from '../theme';
import { Button } from '../ui';
import { GRID_GAP, MAX_QUERY_LENGTH, MORE_TEXT, SEARCH_TEXT } from './text';

const hidden = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;

/** The search field: named for screen readers, its magnifier drawn inside it and hidden from them. */
export function SearchField({ value, onChangeText, onSubmit }: { value: string; onChangeText: (text: string) => void; onSubmit: () => void }) {
  return (
    <View style={styles.field}>
      <View style={styles.fieldIcon} pointerEvents="none" {...hidden}>
        <Icon name="search" color={colors.muted} size={20} />
      </View>
      <TextInput
        testID="search-field"
        accessibilityLabel={SEARCH_TEXT.label}
        placeholder={SEARCH_TEXT.placeholder}
        placeholderTextColor={colors.muted}
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        maxLength={MAX_QUERY_LENGTH}
        returnKeyType="search"
        enterKeyHint="search"
        inputMode="search"
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        style={styles.input}
      />
    </View>
  );
}

/** Poster cards in `columns` columns, each `cardWidth` wide; each is one link, named once. */
export function ResultsGrid({ cards, cardWidth, onOpen }: { cards: readonly Card[]; cardWidth: number; onOpen: (card: Card) => void }) {
  return (
    <View testID="search-grid" style={styles.grid}>
      {cards.map((card, index) => (
        // A title can come back on two pages when TMDB's order moves between them: the place keeps the key unique.
        <PosterCard key={`${index}-${card.mediaType}-${card.tmdbId}`} card={card} width={cardWidth} onOpen={onOpen} />
      ))}
    </View>
  );
}

/** The results' shape while the first page loads: two rows of posters, hidden from screen readers. */
export function SkeletonGrid({ columns, cardWidth }: { columns: number; cardWidth: number }) {
  return (
    <View testID="skeleton-grid" style={styles.grid} {...hidden}>
      {Array.from({ length: columns * 2 }, (_, index) => (
        <View key={index} style={{ width: cardWidth, gap: 5 }}>
          <View style={[styles.skeletonPoster]} />
          <View style={styles.skeletonLine} />
        </View>
      ))}
    </View>
  );
}

/** Load more, or "Loading…" (disabled) while the next page is on its way. */
export function LoadMore({ loading, onPress }: { loading: boolean; onPress: () => void }) {
  return (
    <View style={styles.more}>
      <Button label={loading ? MORE_TEXT.loading : MORE_TEXT.button} onPress={onPress} disabled={loading} secondary />
    </View>
  );
}

const styles = StyleSheet.create({
  field: { justifyContent: 'center' },
  fieldIcon: { position: 'absolute', left: 16, zIndex: 1 },
  input: {
    ...typography.body,
    minHeight: Math.max(layout.touchTarget, 48),
    paddingVertical: 8,
    paddingLeft: 44,
    paddingRight: 16,
    borderRadius: radii.card,
    borderWidth: 1.5,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
    color: colors.text,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: GRID_GAP.column, rowGap: GRID_GAP.row },
  skeletonPoster: { width: '100%', aspectRatio: 2 / 3, borderRadius: radii.poster, backgroundColor: colors.surface },
  skeletonLine: { width: '70%', height: 12, borderRadius: 6, backgroundColor: colors.surface },
  more: { alignItems: 'center' },
});
