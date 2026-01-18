
export const normalizeToMovementId = (name: string): string => {
    if (!name) return 'unknown';
    let clean = name.toLowerCase().trim();
    clean = clean.replace(/[^a-z0-9]+/g, ' ');
    const words = clean.split(' ').filter(w => w.length > 0);
    return words.join('_');
};
