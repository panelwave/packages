/**
 * @panelwave/types — Full TypeScript interfaces for the PanelWave 1.0 manifest format.
 *
 * Generated from: https://panelwave.org/schema/1.0/panelwave.schema.json
 * JSON Schema Draft: 2020-12
 * License: MIT
 */

// ---------------------------------------------------------------------------
// Branded primitives (string aliases for documentation / readability)
// ---------------------------------------------------------------------------

/** Alphanumeric ID: `^[a-zA-Z0-9][a-zA-Z0-9._:-]*$`, 1-200 chars */
export type Identifier = string;

/** BCP-47-like locale code, e.g. `en-US`, `de-DE` */
export type LocaleCode = string;

/** Absolute URI (`format: "uri"`) */
export type Uri = string;

/** CSS hex color, e.g. `#FF0000` or `#F00` */
export type ColorHex = string;

/** ISO 8601 date-time string */
export type Timestamp = string;

/** Non-empty string (minLength 1) */
export type NonEmptyString = string;

/** Integer >= 0 */
export type PositiveInt = number;

/** Number in [0, 1] */
export type NormalizedNumber = number;

/** Tuple `[x, y]` where both are NormalizedNumber */
export type NormalizedPoint = [NormalizedNumber, NormalizedNumber];

// ---------------------------------------------------------------------------
// Common reusable types
// ---------------------------------------------------------------------------

/** Localized string keyed by BCP-47 locale codes */
export type LocalizedString = Record<LocaleCode, string>;

/** Axis-aligned rectangle in normalized coordinates */
export interface NormalizedRect {
  x: NormalizedNumber;
  y: NormalizedNumber;
  w: NormalizedNumber;
  h: NormalizedNumber;
}

/** Generic JSON value (recursive) */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** JSON Logic expression (see jsonlogic.com) */
export type JsonLogic =
  | boolean
  | number
  | string
  | null
  | JsonLogic[]
  | { [operator: string]: JsonLogic };

/** Output format preset identifiers */
export type OutputFormat =
  | 'flex-landscape'
  | 'mobile-portrait'
  | 'bigscreen-landscape'
  | 'a4-portrait'
  | 'a4-landscape'
  | 'us-portrait'
  | 'us-landscape'
  | 'video-16-9';

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------

export type TransitionType = 'none' | 'cut' | 'fade' | 'slide' | 'zoom' | 'push' | 'cover';
export type TransitionDir = 'left' | 'right' | 'up' | 'down';
export type Easing = 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out';

export interface Transition {
  type?: TransitionType;
  dir?: TransitionDir;
  /** Duration in milliseconds (0-60000) */
  durationMs?: number;
  easing?: Easing;
}

// ---------------------------------------------------------------------------
// PanelWave header
// ---------------------------------------------------------------------------

export interface PanelwaveHeader {
  /** Semver string, e.g. `"1.0.0"` */
  version: string;
  /** Absolute URI to schema, e.g. `"https://panelwave.org/schema/1.0/panelwave.schema.json"` */
  schema: Uri;
  /** Optional generator identifier */
  generator?: string;
}

// ---------------------------------------------------------------------------
// Meta / Characters
// ---------------------------------------------------------------------------

export interface Creator {
  role: string;
  name: string;
  url?: Uri;
}

export interface ContentWarning {
  id: Identifier;
  label: LocalizedString;
  defaultBlur?: boolean;
}

export type BalloonType =
  | 'normal'
  | 'rectangle'
  | 'cutTop'
  | 'cutTopRight'
  | 'cutTopLeft'
  | 'thought'
  | 'shout'
  | 'whisper'
  | 'connector';

export type TailCurve = 'straight' | 'left' | 'right';

export interface TailConfig {
  enabled?: boolean;
  /** Degrees 0-359 (compass: 0=top, 90=right, 180=bottom, 270=left) */
  position?: number;
  /** Length in pixels (0-500) */
  length?: number;
  curve?: TailCurve;
  /** 0 = straight, 1 = max curve */
  curveAmount?: number;
}

export interface HideBorderConfig {
  enabled?: boolean;
  /** Center angle in degrees 0-359 */
  angle?: number;
  /** Arc width in degrees 10-180 */
  arc?: number;
}

export interface BalloonConfig {
  balloonType?: BalloonType;
  /** 0 = rectangle, 1 = ellipse */
  cornerRadius?: number;
  maxWidth?: number;
  maxHeight?: number;
  fontFamily?: string;
  fontSize?: number;
  strokeWidth?: number;
  strokeColor?: ColorHex;
  fillColor?: ColorHex;
  tail?: TailConfig;
  hideBorder?: HideBorderConfig;
}

export interface BalloonConfigOverride {
  balloonType?: BalloonType;
  cornerRadius?: number;
  maxWidth?: number;
  maxHeight?: number;
  fontFamily?: string;
  fontSize?: number;
  strokeWidth?: number;
  strokeColor?: ColorHex;
  fillColor?: ColorHex;
  tail?: Partial<TailConfig>;
  hideBorder?: Partial<HideBorderConfig>;
}

export interface CharacterVoice {
  provider?: 'elevenlabs' | 'custom';
  voiceId?: string;
}

export interface Character {
  id: Identifier;
  name: LocalizedString;
  description?: LocalizedString;
  images?: Record<string, string>;
  voice?: CharacterVoice;
  balloonConfig?: BalloonConfigOverride;
}

export interface Meta {
  id: Identifier;
  title: LocalizedString;
  description?: LocalizedString;
  creators?: Creator[];
  publisher?: string;
  series?: string;
  issue?: string;
  /** ISO 8601 date */
  release_date?: string;
  age_rating?: string;
  tags?: string[];
  locales: LocaleCode[];
  default_locale: LocaleCode;
  /** Asset catalog ID or URI */
  cover?: Identifier | Uri;
  characters?: Character[];
  content_warnings?: ContentWarning[];
  copyright?: string;
  license?: string;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export interface AssetBase {
  mediaBase?: Uri;
  imageBase?: Uri;
  audioBase?: Uri;
  videoBase?: Uri;
  sfxBase?: Uri;
  thumbsBase?: Uri;
  pluginsBase?: Uri;
}

export interface AssetCommon {
  id: Identifier;
  locale?: LocaleCode;
  alt?: LocalizedString;
  caption?: LocalizedString;
  transcript?: LocalizedString;
  durationMs?: number;
  sha256?: string;
  tags?: string[];
}

export interface ImageVariant {
  src: string;
  mime: string;
  w: number;
  h: number;
  density?: number;
}

export interface AudioVariant {
  src: string;
  mime: string;
  bitrateKbps?: number;
  channels?: number;
  sampleRateHz?: number;
  loop?: boolean;
  locale?: LocaleCode;
}

export interface VideoVariant {
  src: string;
  mime: string;
  w: number;
  h: number;
  fps?: number;
  codec?: string;
  streaming?: boolean;
  locale?: LocaleCode;
}

export interface SubtitleVariant {
  src: string;
  mime: 'text/vtt' | 'application/x-subrip';
  locale: LocaleCode;
}

export interface VectorVariant {
  src: string;
  mime: 'image/svg+xml' | 'application/pdf';
}

export interface JsonVariant {
  src: string;
  mime: 'application/json';
}

export type AudioRole = 'ambient' | 'music' | 'voiceover' | 'sfx' | 'ui' | 'none';

export interface AssetCatalogItemImage extends AssetCommon {
  category: 'image';
  variants: ImageVariant[];
}

export interface AssetCatalogItemAudio extends AssetCommon {
  category: 'audio';
  role?: AudioRole;
  variants: AudioVariant[];
}

export interface AssetCatalogItemVideo extends AssetCommon {
  category: 'video';
  variants: VideoVariant[];
}

export interface AssetCatalogItemSubtitle extends AssetCommon {
  category: 'subtitle';
  variants: SubtitleVariant[];
}

export interface AssetCatalogItemVector extends AssetCommon {
  category: 'vector';
  variants: VectorVariant[];
}

export interface AssetCatalogItemJson extends AssetCommon {
  category: 'json';
  variants: JsonVariant[];
}

export interface AssetCatalogItemPluginPayload extends AssetCommon {
  category: 'pluginPayload';
  variants: JsonVariant[];
}

export type AssetCatalogItem =
  | AssetCatalogItemImage
  | AssetCatalogItemAudio
  | AssetCatalogItemVideo
  | AssetCatalogItemSubtitle
  | AssetCatalogItemVector
  | AssetCatalogItemJson
  | AssetCatalogItemPluginPayload;

export interface Assets {
  base?: AssetBase;
  catalog?: AssetCatalogItem[];
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

export type VariableType = 'boolean' | 'number' | 'integer' | 'string' | 'enum' | 'date' | 'time' | 'datetime';
export type VariableScope = 'global' | 'chapter' | 'page' | 'session' | 'persistent';
export type VariableVisibility = 'public' | 'private';

export interface VariableDefinition {
  id: string;
  description?: string;
  type: VariableType;
  enum?: string[];
  default?: JsonValue;
  scope: VariableScope;
  visibility?: VariableVisibility;
  readOnly?: boolean;
}

export interface Variables {
  definitions?: VariableDefinition[];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type PanelBorderStyle = 'solid' | 'dashed' | 'dotted' | 'none';
export type PreloadStrategy = 'none' | 'lookahead' | 'aggressive';

export interface TypographySettings {
  default_font?: string;
  default_font_size?: number;
  default_page_bg_color?: ColorHex;
  balloon_config?: BalloonConfig;
  panel_border_style?: {
    color?: ColorHex;
    thickness?: number;
    style?: PanelBorderStyle;
  };
  gutter_width?: number;
}

export interface UIDefaults {
  mangaMode?: boolean;
  autoplayDefault?: boolean;
  secondsPerPanel?: number;
  speechDefault?: boolean;
  audioDefault?: boolean;
  sfxDefault?: boolean;
  scrollingDefault?: boolean;
}

export interface PreloadSettings {
  strategy?: PreloadStrategy;
  panelsAhead?: number;
  maxConcurrent?: number;
}

export interface FormatPreset {
  panelView?: boolean;
  pageView?: boolean;
  defaultTransition?: Transition;
}

export interface Settings {
  typography?: TypographySettings;
  ui?: UIDefaults;
  preload?: PreloadSettings;
  outputPresets?: Partial<Record<OutputFormat, FormatPreset>> & Record<string, FormatPreset>;
}

// ---------------------------------------------------------------------------
// Graph / Edges / Mutations
// ---------------------------------------------------------------------------

export type MutationOp = 'set' | 'increment' | 'toggle' | 'append' | 'remove';

export interface Mutation {
  op: MutationOp;
  var: string;
  value?: JsonValue;
}

export interface Edge {
  from: Identifier;
  to: Identifier;
  condition?: JsonLogic;
  action?: Mutation[];
  transition?: Transition;
  priority?: number;
}

export interface GraphNode {
  label?: LocalizedString;
}

export interface Graph {
  entry: Identifier | Identifier[];
  nodes?: Record<string, GraphNode>;
  edges: Edge[];
}

// ---------------------------------------------------------------------------
// Pages & Layout
// ---------------------------------------------------------------------------

export interface PlacementOrigin {
  x?: NormalizedNumber;
  y?: NormalizedNumber;
}

export interface Placement {
  panelId: Identifier;
  x: number;
  y: number;
  w: number;
  h: number;
  z?: number;
  /** Rotation in degrees (-180 to 180) */
  r?: number;
  origin?: PlacementOrigin;
  /** Visible-area crop (viewport into panel) */
  vx?: NormalizedNumber;
  vy?: NormalizedNumber;
  vw?: NormalizedNumber;
  vh?: NormalizedNumber;
}

export interface GridHelper {
  cols?: number;
  rows?: number;
  visible?: boolean;
  snapEnabled?: boolean;
  snapDistance?: number;
}

export interface CanvasSize {
  width?: number;
  height?: number;
}

export interface PageLayout {
  format: OutputFormat;
  canvasSize?: CanvasSize;
  gridHelper?: GridHelper;
  placements: Placement[];
}

export interface PageMargins {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface PageVisual {
  background_color?: ColorHex;
  background_image?: Identifier | Uri;
  background_texture?: Identifier | Uri;
  margins?: PageMargins;
}

export interface PageTransitions {
  in?: Transition;
  out?: Transition;
}

export interface Page {
  id: Identifier;
  title?: LocalizedString;
  layout: PageLayout;
  readingOrder?: Identifier[];
  visual?: PageVisual;
  transitions?: PageTransitions;
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export interface LayerTransform {
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
}

export interface LayerCommon {
  id?: Identifier;
  z?: number;
  opacity?: NormalizedNumber;
  parallaxDepth?: number;
  dragReveal?: boolean | NormalizedRect;
  transform?: LayerTransform;
  visibleIf?: JsonLogic;
}

export interface ImageLayer extends LayerCommon {
  kind: 'image';
  assetId: Identifier;
  clipRect?: NormalizedRect;
  visibleRect?: NormalizedRect;
}

export interface VectorLayer extends LayerCommon {
  kind: 'vector';
  assetId: Identifier;
}

export interface VideoLayer extends LayerCommon {
  kind: 'video';
  assetId: Identifier;
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  startAtMs?: number;
}

export interface AudioLayer extends LayerCommon {
  kind: 'audio';
  assetId: Identifier;
  loop?: boolean;
  gain?: number;
  startAtMs?: number;
}

export interface TextLayerStyle {
  font?: string;
  sizePt?: number;
  color?: ColorHex;
  strokeColor?: ColorHex;
  strokeWidth?: number;
}

export interface TextLayer extends LayerCommon {
  kind: 'text';
  text: LocalizedString;
  style?: TextLayerStyle;
}

export interface PluginLayer extends LayerCommon {
  kind: 'plugin';
  plugin: PluginInstance;
}

export type Layer = ImageLayer | AudioLayer | VideoLayer | TextLayer | VectorLayer | PluginLayer;

// ---------------------------------------------------------------------------
// Audio tracks
// ---------------------------------------------------------------------------

export interface AudioTrack {
  assetId: Identifier;
  role?: AudioRole;
  loop?: boolean;
  gain?: number;
  startAtMs?: number;
  visibleIf?: JsonLogic;
}

export type SequenceAudioRole = 'ambient' | 'music' | 'voiceover' | 'sfx';
export type SequenceAudioFormat = 'tablet-portrait' | 'mobile-portrait' | 'bigscreen-landscape';

export interface SequenceAudioTrack {
  id: Identifier;
  friendlyId: Identifier;
  name?: string;
  assetId: Identifier;
  role: SequenceAudioRole;
  format?: SequenceAudioFormat;
  /** Start time in ms relative to chapter start */
  startTime: number;
  /** Duration in ms */
  duration: number;
  volume?: number;
  loop?: boolean;
  fadeIn?: number;
  fadeOut?: number;
  playbackRate?: number;
  muted?: boolean;
  startPanelId?: Identifier;
  endPanelId?: Identifier;
}

// ---------------------------------------------------------------------------
// Speech bubbles
// ---------------------------------------------------------------------------

export interface BoundingBox {
  x: NormalizedNumber;
  y: NormalizedNumber;
  w: NormalizedNumber;
  h: NormalizedNumber;
}

export interface SpeechBubble {
  id: Identifier;
  characterId?: Identifier;
  text: LocalizedString;
  audioAssetId?: Identifier;
  shape: BoundingBox;
  balloonConfig?: BalloonConfigOverride;
  visibleIf?: JsonLogic;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface RectShape {
  type: 'rect';
  x: NormalizedNumber;
  y: NormalizedNumber;
  w: NormalizedNumber;
  h: NormalizedNumber;
}

export interface CircleShape {
  type: 'circle';
  cx: NormalizedNumber;
  cy: NormalizedNumber;
  r: NormalizedNumber;
}

export interface EllipseShape {
  type: 'ellipse';
  x: NormalizedNumber;
  y: NormalizedNumber;
  w: NormalizedNumber;
  h: NormalizedNumber;
}

export interface PolygonShape {
  type: 'polygon';
  points: NormalizedPoint[];
}

export type Shape = RectShape | CircleShape | EllipseShape | PolygonShape;

// ---------------------------------------------------------------------------
// Hotspots
// ---------------------------------------------------------------------------

export interface HotspotActionGoTo {
  type: 'goTo';
  to: Identifier;
  mutations?: Mutation[];
  transition?: Transition;
}

export interface HotspotActionSetVariables {
  type: 'setVariables';
  mutations: Mutation[];
}

export interface HotspotActionOpenExtras {
  type: 'openExtras';
  extrasId: Identifier;
}

export interface HotspotActionOpenModal {
  type: 'openModal';
  title: LocalizedString;
  content: LocalizedString;
}

export interface HotspotActionPluginEvent {
  type: 'pluginEvent';
  pluginId: Identifier;
  event: string;
  payload?: JsonValue;
}

export type HotspotAction =
  | HotspotActionGoTo
  | HotspotActionSetVariables
  | HotspotActionOpenExtras
  | HotspotActionOpenModal
  | HotspotActionPluginEvent;

export interface Hotspot {
  id: Identifier;
  shape: Shape;
  label: LocalizedString;
  ariaLabel?: LocalizedString;
  action: HotspotAction;
  visibleIf?: JsonLogic;
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export interface PluginInstance {
  pluginId: Identifier;
  instanceId: Identifier;
  payloadId?: Identifier;
  props?: JsonValue;
  sandbox?: 'iframe' | 'worker';
  stateVariables?: string[];
}

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

export interface AccessibilityHints {
  alt?: LocalizedString;
  labels?: Record<string, LocalizedString>;
}

// ---------------------------------------------------------------------------
// Panel animations
// ---------------------------------------------------------------------------

export interface PanelAnimations {
  startViewportRect?: NormalizedRect;
  endViewportRect?: NormalizedRect;
  durationMs?: number;
  easing?: Easing;
}

export interface PanelFormatView {
  minimalFocusRect?: NormalizedRect;
  allowPageView?: boolean;
  allowPanelView?: boolean;
}

// ---------------------------------------------------------------------------
// Panel variants
// ---------------------------------------------------------------------------

export interface PanelPartial {
  title?: LocalizedString;
  description?: LocalizedString;
  durationMs?: number;
  formatViews?: Record<string, PanelFormatView>;
  layers?: Layer[];
  animations?: PanelAnimations;
  speechBubbles?: SpeechBubble[];
  hotspots?: Hotspot[];
  audio?: AudioTrack[];
  video?: VideoLayer[];
  plugins?: PluginInstance[];
  shareable?: boolean;
  age_rating_override?: string;
  preloadHints?: Identifier[];
  memoryBudgetHint?: number;
  contentWarnings?: Identifier[];
}

export interface PanelVariant {
  id: Identifier;
  when: JsonLogic;
  overrides: PanelPartial;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export interface Panel {
  id?: Identifier;
  title?: LocalizedString;
  description?: LocalizedString;
  /** Duration in ms for autoplay */
  durationMs?: number;
  formatViews?: Record<string, PanelFormatView>;
  layers?: Layer[];
  animations?: PanelAnimations;
  speechBubbles?: SpeechBubble[];
  hotspots?: Hotspot[];
  audio?: AudioTrack[];
  video?: VideoLayer[];
  plugins?: PluginInstance[];
  accessibility?: AccessibilityHints;
  shareable?: boolean;
  age_rating_override?: string;
  variants?: PanelVariant[];
  preloadHints?: Identifier[];
  memoryBudgetHint?: number;
  contentWarnings?: Identifier[];
}

// ---------------------------------------------------------------------------
// Chapter
// ---------------------------------------------------------------------------

export interface Chapter {
  id: Identifier;
  title?: LocalizedString;
  pages?: Page[];
  panels: Record<Identifier, Panel>;
  sequenceAudioTracks?: SequenceAudioTrack[];
  graph: Graph;
}

// ---------------------------------------------------------------------------
// Extras
// ---------------------------------------------------------------------------

export interface ExtraBlockImage {
  assetId?: Identifier;
  caption?: LocalizedString;
}

export interface ExtraBlock {
  id?: Identifier;
  title?: LocalizedString;
  text?: LocalizedString;
  images?: ExtraBlockImage[];
  audio?: AudioTrack[];
  video?: VideoLayer[];
  shareable?: boolean;
  gated?: boolean;
}

export interface ExtraCharacterSheet extends ExtraBlock {
  characterId: Identifier;
}

export interface Extras {
  cover?: ExtraBlock;
  alt_cover?: ExtraBlock;
  character_sheets?: ExtraCharacterSheet[];
  author_info?: ExtraBlock;
  author_interviews?: ExtraBlock[];
  bonus_art?: ExtraBlock[];
  fan_art?: ExtraBlock[];
  behind_the_scenes?: ExtraBlock[];
}

// ---------------------------------------------------------------------------
// Paywall
// ---------------------------------------------------------------------------

export type PaywallScope = 'work' | 'chapter' | 'panel' | 'extras';

export interface PaywallRule {
  id?: Identifier;
  scope: PaywallScope;
  refId?: Identifier;
  requireEntitlement: string;
  previewPanels?: number;
  ageGate?: number;
}

export interface Paywall {
  rules?: PaywallRule[];
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

export type TrackingEvent =
  | 'session_start'
  | 'session_end'
  | 'panel_view'
  | 'dwell_time'
  | 'transition'
  | 'hotspot_click'
  | 'decision'
  | 'autoplay_start'
  | 'autoplay_stop'
  | 'lang_change'
  | 'audio_toggle'
  | 'sfx_toggle'
  | 'speech_toggle'
  | 'paywall_view'
  | 'like'
  | 'bookmark'
  | 'share'
  | 'comment_posted'
  | 'export_triggered';

export interface TrackingConsent {
  required?: boolean;
  defaultOptIn?: boolean;
}

export interface Tracking {
  enabled?: boolean;
  consent?: TrackingConsent;
  eventWhitelist?: TrackingEvent[];
  endpoint?: Uri;
}

// ---------------------------------------------------------------------------
// UI Settings
// ---------------------------------------------------------------------------

export interface UIBranding {
  primaryColor?: ColorHex;
  accentColor?: ColorHex;
  logo?: string;
}

export interface UIControls {
  showLanguageToggle?: boolean;
  showAutoplayToggle?: boolean;
  showSfxToggle?: boolean;
  showSpeechToggle?: boolean;
  showToc?: boolean;
  showThumbnails?: boolean;
}

export interface UISettings {
  branding?: UIBranding;
  controls?: UIControls;
}

// ---------------------------------------------------------------------------
// Root manifest
// ---------------------------------------------------------------------------

/**
 * A complete PanelWave 1.0 manifest.
 *
 * Three top-level sections are required: `panelwave`, `meta`, `chapters`.
 * All others are optional. Extension properties prefixed `x-` are allowed.
 */
export interface PanelwaveManifest {
  panelwave: PanelwaveHeader;
  meta: Meta;
  chapters: Chapter[];
  assets?: Assets;
  variables?: Variables;
  settings?: Settings;
  extras?: Extras;
  paywall?: Paywall;
  tracking?: Tracking;
  ui?: UISettings;
  /** Extension properties (x-*) */
  [key: `x-${string}`]: unknown;
}
