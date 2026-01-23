export type EntityType = 'ex' | 'meal';
export type PersonaType = 'atlas' | 'nova' | 'mannequin' | 'none';
export type Subtype = 'main' | 'step' | 'meta' | 'video';

export interface AssetKeyComponents {
    type: EntityType;
    id: string; // Slug or UUID
    persona: PersonaType;
    subtype: Subtype;
    index: number;
}

/**
 * UnifiedKey - The central Domain Object for all Asset identification.
 * Ensures structural impeccableness by enforcing strict formatting and parsing.
 */
export class UnifiedKey {
    private readonly components: AssetKeyComponents;

    constructor(components: AssetKeyComponents) {
        this.components = { ...components };
        this.validate();
    }

    private validate() {
        if (!this.components.id) throw new Error('UnifiedKey: ID is required');
        if (this.components.index < 0) throw new Error('UnifiedKey: Index must be >= 0');
    }

    /**
     * Parse a string key into a UnifiedKey object.
     */
    static parse(key: string): UnifiedKey {
        const parts = key.split(':');
        if (parts.length !== 5) {
            throw new Error(`UnifiedKey: Invalid key format "${key}". Expected type:id:persona:subtype:index`);
        }

        return new UnifiedKey({
            type: parts[0] as EntityType,
            id: parts[1],
            persona: parts[2] as PersonaType,
            subtype: parts[3] as Subtype,
            index: parseInt(parts[4], 10)
        });
    }

    /**
     * Stringify the key for database storage and referencing.
     */
    toString(): string {
        const { type, id, persona, subtype, index } = this.components;
        return `${type}:${id}:${persona}:${subtype}:${index}`;
    }

    get type() { return this.components.type; }
    get id() { return this.components.id; }
    get persona() { return this.components.persona; }
    get subtype() { return this.components.subtype; }
    get index() { return this.components.index; }

    /**
     * Helper to create a meta key for any given entity key.
     */
    toMetaKey(): UnifiedKey {
        return new UnifiedKey({
            ...this.components,
            persona: 'none',
            subtype: 'meta',
            index: 0
        });
    }
}
