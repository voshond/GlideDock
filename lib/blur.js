// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';

// Shell.BlurEffect can only blur a rectangle. This effect cuts the blurred
// rectangle down to a rounded one, with a one pixel soft edge.
const DECLARATIONS = `
uniform vec2 glidedock_size;
uniform vec2 glidedock_bar_origin;
uniform vec2 glidedock_bar_scale;
uniform vec2 glidedock_offscreen_origin;
uniform vec2 glidedock_offscreen_size;
uniform float glidedock_radius;

float glidedock_coverage(vec2 point) {
    vec2 half_size = glidedock_size * 0.5;
    vec2 corner = abs(point - half_size) - (half_size - glidedock_radius);
    float distance = length(max(corner, 0.0)) + min(max(corner.x, corner.y), 0.0) - glidedock_radius;
    return clamp(0.5 - distance, 0.0, 1.0);
}`;
const CODE = `
vec2 glidedock_point = glidedock_offscreen_origin + cogl_tex_coord_in[0].st * glidedock_offscreen_size;
cogl_color_out *= glidedock_coverage((glidedock_point - glidedock_bar_origin) / glidedock_bar_scale);`;

const getOffscreenSpan = length => {
    const end = Math.ceil(length + 0.75);
    const size = Math.round(length) + 3;
    return [end - size, size];
};

const applyShape = (setUniform, stripWidth, stripHeight, bar) => {
    const [originX, offscreenWidth] = getOffscreenSpan(stripWidth);
    const [originY, offscreenHeight] = getOffscreenSpan(stripHeight);
    setUniform('glidedock_size', [bar.width, bar.height]);
    setUniform('glidedock_bar_origin', [bar.x, bar.y]);
    setUniform('glidedock_bar_scale', [bar.scaleX, bar.scaleY]);
    setUniform('glidedock_offscreen_origin', [originX, originY]);
    setUniform('glidedock_offscreen_size', [offscreenWidth, offscreenHeight]);
    setUniform('glidedock_radius', [Math.min(bar.radius, bar.width / 2, bar.height / 2)]);
};

// Shell.GLSLEffect was replaced by Clutter.ShaderEffect in GNOME 51.
const RoundedClipEffect = Shell.GLSLEffect
    ? GObject.registerClass(
        class GlideDockRoundedClipEffect extends Shell.GLSLEffect {
            vfunc_build_pipeline() {
                // The hook enum moved from Shell to Cogl in GNOME 48.
                const hook = Shell.SnippetHook?.FRAGMENT ?? Cogl.SnippetHook.FRAGMENT;
                this.add_glsl_snippet(hook, DECLARATIONS, CODE, false);
            }

            setShape(stripWidth, stripHeight, bar) {
                applyShape((name, values) => this.set_uniform_float(
                    this.get_uniform_location(name), values.length, values),
                stripWidth, stripHeight, bar);
                this.queue_repaint();
            }
        })
    : GObject.registerClass(
        class GlideDockRoundedClipEffect extends Clutter.ShaderEffect {
            vfunc_get_static_snippet() {
                return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE);
            }

            setShape(stripWidth, stripHeight, bar) {
                applyShape((name, values) => this.set_uniform_float(name, values.length, values),
                    stripWidth, stripHeight, bar);
            }
        });

/**
 * A blurred, rounded copy of the wallpaper to put behind a translucent dock.
 *
 * It is a copy of the wallpaper cut to a strip as long as the monitor, blurred,
 * then cut to the shape of the bar. The strip never moves against the wallpaper
 * and the bar can stretch without blurring again, so after the first frame it
 * costs one cached texture.
 *
 * The constructor throws if this shell cannot build it.
 */
export class BlurLayer {
    /** @param {number} monitorIndex - monitor whose wallpaper is shown */
    constructor(monitorIndex) {
        // Never asks for space of its own; the parent stretches it.
        this.actor = new Clutter.Actor({
            layout_manager: new Clutter.FixedLayout(),
            x_expand: true,
            y_expand: true,
            min_width: 0,
            min_height: 0,
            natural_width: 0,
            natural_height: 0,
        });

        try {
            this._vertical = false;
            this._thickness = new Clutter.BindConstraint({
                source: this.actor,
                coordinate: Clutter.BindCoordinate.HEIGHT,
            });
            this.strip = new Clutter.Actor({
                layout_manager: new Clutter.FixedLayout(),
                clip_to_allocation: true,
            });
            this.strip.add_constraint(this._thickness);
            this.actor.add_child(this.strip);

            // Effects wrap from last to first: blur the wallpaper, then round it.
            this._clipEffect = new RoundedClipEffect();
            this._blurEffect = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR});
            this.strip.add_effect(this._clipEffect);
            this.strip.add_effect(this._blurEffect);

            // BackgroundManager keeps a wallpaper actor in the holder up to
            // date across wallpaper changes.
            this._wallpaper = new Clutter.Actor({layout_manager: new Clutter.FixedLayout()});
            this.strip.add_child(this._wallpaper);
            this._manager = new Background.BackgroundManager({
                container: this._wallpaper,
                monitorIndex,
                controlPosition: false,
                vignette: false,
            });
        } catch (e) {
            this.destroy();
            throw e;
        }
    }

    destroy() {
        this._manager?.destroy();
        this._manager = null;
        this.actor?.destroy();
        this.actor = null;
        this.strip = null;
        this._thickness = null;
        this._wallpaper = null;
        this._clipEffect = null;
        this._blurEffect = null;
    }

    /**
     * @param {number} sigma - standard deviation of the blur, in physical pixels
     * @param {number} brightness - 0 (black) to 1 (unchanged)
     */
    setBlur(sigma, brightness) {
        // The property was called sigma before GNOME 46; radius is 2 sigma.
        if (this._blurEffect.radius !== undefined)
            this._blurEffect.radius = sigma * 2;
        else
            this._blurEffect.sigma = sigma;
        this._blurEffect.brightness = brightness;
    }

    /**
     * @param {boolean} vertical - whether the dock runs top to bottom
     * @param {number} length - length of the monitor along the dock
     */
    setAxis(vertical, length) {
        this._vertical = vertical;
        this._thickness.coordinate = vertical
            ? Clutter.BindCoordinate.WIDTH
            : Clutter.BindCoordinate.HEIGHT;
        this.strip.set_size(vertical ? -1 : length, vertical ? length : -1);
    }

    /**
     * Lines the wallpaper copy up with the real wallpaper and sets the shape.
     * Uses translations, so it is safe to call from allocation handlers.
     *
     * @param {number} offsetX - monitor origin minus the layer's origin, in stage pixels
     * @param {number} offsetY - same, vertically
     * @param {object} bar - the bar over the layer: `x`, `y`, `width`, `height`
     *     at rest, `scaleX`, `scaleY` its stretch from `x`, `y`, and `radius`
     *     its corner radius in physical pixels
     */
    sync(offsetX, offsetY, bar) {
        const stripX = this._vertical ? 0 : offsetX;
        const stripY = this._vertical ? offsetY : 0;
        this.strip.set_translation(stripX, stripY, 0);
        this._wallpaper.set_translation(offsetX - stripX, offsetY - stripY, 0);
        this._clipEffect.setShape(this.strip.width, this.strip.height, {
            ...bar,
            x: bar.x - stripX,
            y: bar.y - stripY,
        });
    }
}
