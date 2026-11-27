//! Window-independent split layout. SSH channels and GPUI entities live outside this tree.
use portiva_core::TerminalId;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SplitDirection {
    Columns,
    Rows,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TerminalLayout {
    Terminal(TerminalId),
    Split {
        id: Uuid,
        direction: SplitDirection,
        first: Box<Self>,
        second: Box<Self>,
    },
}

impl TerminalLayout {
    pub(crate) fn first_terminal(&self) -> TerminalId {
        match self {
            Self::Terminal(id) => *id,
            Self::Split { first, .. } => first.first_terminal(),
        }
    }

    pub(crate) fn contains(&self, terminal: TerminalId) -> bool {
        match self {
            Self::Terminal(id) => *id == terminal,
            Self::Split { first, second, .. } => {
                first.contains(terminal) || second.contains(terminal)
            }
        }
    }

    pub(crate) fn split(
        &mut self,
        target: TerminalId,
        terminal: TerminalId,
        direction: SplitDirection,
    ) -> bool {
        if self.contains(terminal) {
            return false;
        }
        self.insert(target, terminal, direction)
    }

    fn insert(
        &mut self,
        target: TerminalId,
        terminal: TerminalId,
        direction: SplitDirection,
    ) -> bool {
        match self {
            Self::Terminal(id) if *id == target => {
                *self = Self::Split {
                    id: Uuid::new_v4(),
                    direction,
                    first: Box::new(Self::Terminal(target)),
                    second: Box::new(Self::Terminal(terminal)),
                };
                true
            }
            Self::Split { first, second, .. } => {
                first.insert(target, terminal, direction)
                    || second.insert(target, terminal, direction)
            }
            _ => false,
        }
    }

    /// Collapse the removed leaf's parent and focus its surviving sibling.
    /// A leaf cannot remove itself, so the final terminal always remains.
    pub(crate) fn close(&mut self, target: TerminalId) -> Option<TerminalId> {
        let Self::Split { first, second, .. } = self else {
            return None;
        };
        if matches!(first.as_ref(), Self::Terminal(id) if *id == target) {
            *self = second.as_ref().clone();
            return Some(self.first_terminal());
        }
        if matches!(second.as_ref(), Self::Terminal(id) if *id == target) {
            *self = first.as_ref().clone();
            return Some(self.first_terminal());
        }
        first.close(target).or_else(|| second.close(target))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_splits_close_only_the_target_and_collapse_its_parent() {
        let [a, b, c, d] = [1, 2, 3, 4].map(Uuid::from_u128);
        let mut tree = TerminalLayout::Terminal(a);
        assert!(tree.split(a, b, SplitDirection::Columns));
        assert!(tree.split(b, c, SplitDirection::Rows));
        assert!(tree.split(a, d, SplitDirection::Rows));
        let TerminalLayout::Split { id, first, .. } = &tree else {
            panic!("missing outer split");
        };
        let outer_id = *id;
        let untouched = first.clone();
        assert_eq!(tree.close(b), Some(c));
        let TerminalLayout::Split {
            id, first, second, ..
        } = &tree
        else {
            panic!("closing a nested leaf removed the outer split");
        };
        assert_eq!(*id, outer_id);
        assert_eq!(*first, untouched);
        assert_eq!(**second, TerminalLayout::Terminal(c));
        assert_eq!(tree.close(c), Some(a));
        assert_eq!(tree.close(a), Some(d));
        assert_eq!(tree, TerminalLayout::Terminal(d));
        assert_eq!(tree.close(d), None);
    }

    #[test]
    fn invalid_edits_preserve_the_tree_and_last_terminal() {
        let [a, b, unknown] = [1, 2, 3].map(Uuid::from_u128);
        let mut tree = TerminalLayout::Terminal(a);
        assert_eq!(tree.close(a), None);
        assert!(!tree.split(unknown, b, SplitDirection::Rows));
        assert!(!tree.split(a, a, SplitDirection::Columns));
        assert!(tree.split(a, b, SplitDirection::Columns));
        let before = tree.clone();
        assert!(!tree.split(a, b, SplitDirection::Rows));
        assert_eq!(tree.close(unknown), None);
        assert_eq!(tree, before);
    }
}
