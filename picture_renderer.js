'use strict';

/**
 * A relatively thin wrapper around a canvas and context used by a Picture.
 * TODO: Make it so that this can be used with multiple Pictures. Right now the GL viewport is not set properly for
 * Rasterizers yet.
 * Maintains state that isn't specific to a single picture, such as the compositor and brush texture collection.
 * @param {string=} mode Either 'webgl', 'no-texdata-webgl' or 'canvas'. Defaults to 'webgl'.
 * @param {Array.<HTMLImageElement|HTMLCanvasElement>=} brushTextureData Set of brush textures to use. Can be undefined
 * if no textures are needed.
 */
var PictureRenderer = function(mode, brushTextureData) {
    if (mode === undefined) {
        mode = 'webgl';
    }
    this.mode = mode;
    this.brushTextureData = brushTextureData;

    this.canvas = document.createElement('canvas');

    if (this.usesWebGl()) {
        if (!this.setupGLState()) {
            this.mode = undefined;
        }
    } else if (this.mode === 'canvas') {
        this.ctx = this.canvas.getContext('2d');
        this.compositor = new CanvasCompositor(this.ctx);
        this.brushTextures = new CanvasBrushTextures();
        this.initBrushTextures();
    } else {
        this.mode = undefined;
    }
};

/**
 * True if WebGL context was initialized but a rendering test produced wrong results.
 */
PictureRenderer.hasFailedWebGLSanity = false;

/**
 * @return {boolean} Does the renderer use WebGL?
 */
PictureRenderer.prototype.usesWebGl = function() {
    return (this.mode === 'webgl' || this.mode === 'no-float-webgl' ||
            this.mode === 'no-texdata-webgl');
};

PictureRenderer.prototype.prepareDisplay = function(picture) {
    this.canvas.width = picture.bitmapWidth();
    this.canvas.height = picture.bitmapHeight();
    if (this.usesWebGl()) {
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        this.gl.scissor(0, 0, this.canvas.width, this.canvas.height);
        this.glManager.useFbo(null);
    }
};

/**
 * @param {HTMLCanvasElement} canvas Canvas to use for rasterization.
 * @param {boolean=} debugGL True to log every WebGL call made on the context. Defaults to false.
 * @return {WebGLRenderingContext} Context to use or null if unsuccessful.
 */
PictureRenderer.initWebGL = function(canvas, debugGL) {
    if (debugGL === undefined) {
        debugGL = false;
    }
    var contextAttribs = {
        antialias: false,
        stencil: false,
        depth: false,
        premultipliedAlpha: false
    };
    var gl = glUtils.initGl(canvas, contextAttribs, 4);
    if (!gl) {
        return null;
    }
    if (debugGL) {
        var logGLCall = function(functionName, args) {
            console.log('gl.' + functionName + '(' + WebGLDebugUtils.glFunctionArgsToString(functionName, args) + ');');
        };
        gl = WebGLDebugUtils.makeDebugContext(gl, undefined, logGLCall);
    }
    gl.getExtension('OES_texture_float');

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST); // scissor rect is initially set to canvas size.
    gl.hint(gl.GENERATE_MIPMAP_HINT, gl.NICEST);
    return gl;
};

/**
 * Set up state in an existing gl context.
 * @return {boolean} Whether buffer initialization succeeded.
 */
PictureRenderer.prototype.setupGLState = function() {
    var useFloatRasterizer = (this.mode === 'webgl' || this.mode === 'no-texdata-webgl');
    if (useFloatRasterizer && !glUtils.floatFboSupported) {
        return false;
    }

    this.gl = PictureRenderer.initWebGL(this.canvas);
    if (!this.gl) {
        return false;
    }
    this.glManager = glStateManager(this.gl);
    this.glManager.useQuadVertexBuffer(); // All drawing is done using the same vertex array
    this.loseContext = this.gl.getExtension('WEBGL_lose_context');

    this.brushTextures = new GLBrushTextures(this.gl, this.glManager);
    this.initBrushTextures();

    if (useFloatRasterizer) {
        if (this.mode === 'webgl') {
            this.glRasterizerConstructor = GLFloatTexDataRasterizer;
        } else {
            // TODO: assert(this.mode === 'no-texdata-webgl');
            this.glRasterizerConstructor = GLFloatRasterizer;
        }
    } else {
        this.glRasterizerConstructor = GLDoubleBufferedRasterizer;
    }

    this.texBlitProgram = this.glManager.shaderProgram(blitShader.blitSrc,
                                                       blitShader.blitVertSrc,
                                                       {'uSrcTex': 'tex2d'});
    this.rectBlitProgram = this.glManager.shaderProgram(blitShader.blitSrc,
                                                        blitShader.blitScaledTranslatedVertSrc,
                                                        {'uSrcTex': 'tex2d', 'uScale': '2fv', 'uTranslate': '2fv'});

    this.compositor = new GLCompositor(this.glManager, this.gl, glUtils.maxTextureUnits);
    return true;
};

/**
 * Initialize brush textures to use in rasterizers from the given brush texture data.
 * @protected
 */
PictureRenderer.prototype.initBrushTextures = function() {
    if (!this.brushTextureData) {
        return;
    }
    for (var i = 0; i < this.brushTextureData.length; ++i) {
        this.brushTextures.addTexture(this.brushTextureData[i]);
    }
};
