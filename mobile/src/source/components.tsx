// A network's or studio's page's own pieces, the PWA's sourceTabs() (app/src/render.ts) in the Tidepool look: the
// All | Series | Films control as a tab list, each tab a thumb's size, the chosen one filled with the cyan tint,
// outlined in cyan and heavier, so it is never told by colour alone. Text grows with the system font size and wraps.
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SOURCE_TEXT, type SourceList } from '../home/text';
import { colors, layout, radii, spacing } from '../theme';

export function SourceTabs({ lists, selected, onChoose }: { lists: readonly SourceList[]; selected: SourceList; onChoose: (list: SourceList) => void }) {
  return (
    <View testID="source-tabs" accessibilityRole="tablist" accessibilityLabel={SOURCE_TEXT.listsLabel} style={styles.tabs}>
      {lists.map((list) => {
        const chosen = list === selected;
        return (
          <Pressable
            key={list}
            testID={`source-tab-${list}`}
            accessibilityRole="tab"
            accessibilityLabel={SOURCE_TEXT.lists[list]}
            accessibilityState={{ selected: chosen }}
            onPress={() => onChoose(list)}
            style={({ pressed }) => [styles.tab, chosen && styles.tabChosen, pressed && styles.pressed]}
          >
            <Text style={[styles.tabText, chosen && styles.tabTextChosen]}>{SOURCE_TEXT.lists[list]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    gap: spacing.xxs,
    padding: spacing.xxs,
    borderWidth: 1.5,
    borderColor: colors.hairline,
    borderRadius: radii.chip,
    alignSelf: 'stretch',
  },
  tab: {
    flex: 1,
    minHeight: layout.touchTarget,
    minWidth: layout.touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderWidth: 1.5,
    borderColor: 'transparent',
    borderRadius: radii.chip,
  },
  tabChosen: { backgroundColor: colors.accentTint, borderColor: colors.accent },
  pressed: { opacity: 0.75 },
  tabText: { fontSize: 15.2, lineHeight: 20, fontWeight: '700', textAlign: 'center', color: colors.muted },
  tabTextChosen: { fontWeight: '800', color: colors.accentText },
});
