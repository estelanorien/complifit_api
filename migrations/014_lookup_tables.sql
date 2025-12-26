-- Lookup tables for dropdown lists & planners
CREATE TABLE IF NOT EXISTS training_goal_categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category text NOT NULL,
    goal text NOT NULL,
    UNIQUE (category, goal)
);

INSERT INTO training_goal_categories (category, goal) VALUES
    ('Body Composition', 'Fat Loss'),
    ('Body Composition', 'Muscle Gain'),
    ('Body Composition', 'Recomposition'),
    ('Performance', 'Strength'),
    ('Performance', 'Power'),
    ('Performance', 'Speed'),
    ('Performance', 'Agility'),
    ('Performance', 'Endurance'),
    ('Skill-Based', 'Sport Specific'),
    ('Skill-Based', 'Movement Mastery'),
    ('Skill-Based', 'Coordination'),
    ('Health-Oriented', 'Mobility'),
    ('Health-Oriented', 'Flexibility'),
    ('Health-Oriented', 'Posture Correction'),
    ('Health-Oriented', 'Longevity'),
    ('Mental & Recovery', 'Stress Reduction'),
    ('Mental & Recovery', 'Mind-Body Integration'),
    ('Mental & Recovery', 'Sleep Aid'),
    ('Lifestyle', 'General Fitness'),
    ('Lifestyle', 'Active Aging'),
    ('Lifestyle', 'Functional Movement')
ON CONFLICT (category, goal) DO NOTHING;

CREATE TABLE IF NOT EXISTS nutrition_goal_categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category text NOT NULL,
    goal text NOT NULL,
    UNIQUE (category, goal)
);

INSERT INTO nutrition_goal_categories (category, goal) VALUES
    ('Body Composition', 'Lose Fat'),
    ('Body Composition', 'Gain Muscle'),
    ('Body Composition', 'Recomposition'),
    ('Body Composition', 'Maintain Weight'),
    ('Performance', 'Fuel for Strength'),
    ('Performance', 'Endurance Fuel'),
    ('Performance', 'Rapid Recovery'),
    ('Performance', 'Athletic Output'),
    ('Health Optimization', 'Metabolic Health'),
    ('Health Optimization', 'Lower Cholesterol'),
    ('Health Optimization', 'Blood Sugar Control'),
    ('Health Optimization', 'Gut Health'),
    ('Medical/Clinical', 'Anti-inflammatory'),
    ('Medical/Clinical', 'Low-FODMAP'),
    ('Medical/Clinical', 'Diabetic-friendly'),
    ('Medical/Clinical', 'Renal support'),
    ('Mental & Cognitive', 'Brain Health'),
    ('Mental & Cognitive', 'Mood Support'),
    ('Mental & Cognitive', 'Focus Enhancement'),
    ('Longevity & Aging', 'Anti-aging'),
    ('Longevity & Aging', 'Bone Density'),
    ('Longevity & Aging', 'Hormonal Balance')
ON CONFLICT (category, goal) DO NOTHING;

CREATE TABLE IF NOT EXISTS sports (
    id text PRIMARY KEY,
    label text NOT NULL
);

INSERT INTO sports (id, label) VALUES
    ('general', 'General'),
    ('basketball', 'Basketball'),
    ('football', 'Football'),
    ('american_football', 'American Football'),
    ('tennis', 'Tennis'),
    ('boxing', 'Boxing'),
    ('yoga', 'Yoga'),
    ('running', 'Running'),
    ('swimming', 'Swimming'),
    ('cycling', 'Cycling'),
    ('baseball', 'Baseball'),
    ('golf', 'Golf'),
    ('hockey', 'Hockey'),
    ('volleyball', 'Volleyball'),
    ('mma', 'MMA'),
    ('cricket', 'Cricket'),
    ('rugby', 'Rugby')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS cuisines (
    id text PRIMARY KEY,
    label text NOT NULL,
    icon text
);

INSERT INTO cuisines (id, label, icon) VALUES
    ('turkish', 'Turkish', '🇹🇷'),
    ('mediterranean', 'Mediterranean', '🫒'),
    ('asian', 'Asian Fusion', '🥢'),
    ('indian', 'Indian', '🍛'),
    ('latin', 'Latin American', '🌮'),
    ('middle_eastern', 'Middle Eastern', '🥙'),
    ('african', 'African', '🌍'),
    ('european', 'European', '🥐'),
    ('american', 'American', '🍔'),
    ('global', 'Global', '🌐')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS met_values (
    activity_key text PRIMARY KEY,
    label text,
    value numeric(5,2) NOT NULL
);

INSERT INTO met_values (activity_key, label, value) VALUES
    ('general', 'General', 3.5),
    ('yoga', 'Yoga', 2.5),
    ('walking', 'Walking', 3.5),
    ('running', 'Running', 8.0),
    ('cycling', 'Cycling', 7.5),
    ('swimming', 'Swimming', 6.0),
    ('weight_lifting', 'Weight Lifting', 3.5),
    ('circuit', 'Circuit', 8.0),
    ('hiit', 'HIIT', 8.0),
    ('basketball', 'Basketball', 6.5),
    ('soccer', 'Soccer', 7.0),
    ('tennis', 'Tennis', 7.0),
    ('boxing', 'Boxing', 9.0),
    ('martial_arts', 'Martial Arts', 10.0),
    ('cardio', 'Cardio', 7.0)
ON CONFLICT (activity_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS equipment_options (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key text UNIQUE NOT NULL,
    label text NOT NULL
);

INSERT INTO equipment_options (key, label) VALUES
    ('gym', 'Gym Access'),
    ('home_basic', 'Home Basics'),
    ('bodyweight', 'Bodyweight Only'),
    ('park', 'Park / Outdoor'),
    ('beach', 'Beach / Sand'),
    ('pool', 'Swimming Pool'),
    ('dumbbells', 'Dumbbells'),
    ('barbell', 'Barbell Setup'),
    ('kettlebell', 'Kettlebell'),
    ('resistance_bands', 'Resistance Bands'),
    ('pullup_bar', 'Pull-up Bar'),
    ('bench', 'Bench'),
    ('basketball', 'Basketball Court'),
    ('soccer_ball', 'Soccer Ball'),
    ('tennis_racket', 'Tennis Gear'),
    ('yoga_mat', 'Yoga Mat'),
    ('boxing_gloves', 'Boxing Gloves'),
    ('hoop', 'Hoop / Net')
ON CONFLICT (key) DO NOTHING;

