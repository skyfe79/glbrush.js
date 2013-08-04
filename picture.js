/*
 * Copyright Olli Etuaho 2012-2013.
 */

/**
 * @constructor
 * @param {number} id Picture's unique id number.
 * @param {Rect} boundsRect Picture bounds. x and y should always be zero.
 * @param {number} bitmapScale Scale for rasterizing the picture. Events that
 * are pushed to this picture get this scale applied to them.
 * @param {string=} mode Either 'webgl', 'no-texdata-webgl' or 'canvas'.
 * Defaults to 'webgl'.
 * @param {number} currentBufferAttachment Which buffer index to attach the
 * picture's current buffer to. Can be set to -1 if no current buffer is needed.
 */
var Picture = function(id, boundsRect, bitmapScale, mode,
                       currentBufferAttachment) {
    this.id = id;
    if (mode === undefined) {
        mode = 'webgl';
    }
    this.mode = mode;

    this.animating = false;

    this.buffers = [];
    this.currentBuffer = false;
    this.currentBufferAttachment = currentBufferAttachment;
    this.currentEvent = null;
    this.currentBufferMode = BrushEvent.Mode.normal;

    this.boundsRect = boundsRect;
    this.bitmapScale = bitmapScale;
    var bitmapWidth = Math.floor(this.boundsRect.width() * this.bitmapScale);
    var bitmapHeight = Math.floor(this.boundsRect.height() * this.bitmapScale);
    this.bitmapRect = new Rect(0, bitmapWidth, 0, bitmapHeight);

    this.container = null;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.bitmapWidth();
    this.canvas.height = this.bitmapHeight();

    if (this.usesWebGl()) {
        this.gl = Picture.initWebGL(this.canvas);
        if (this.gl === null || !this.setupGLState()) {
            this.mode = undefined;
            return;
        }
    } else if (this.mode === 'canvas') {
        this.ctx = this.canvas.getContext('2d');
        this.compositingCanvas = document.createElement('canvas');
        this.compositingCanvas.width = this.bitmapWidth();
        this.compositingCanvas.height = this.bitmapHeight();
        this.compositingCtx = this.compositingCanvas.getContext('2d');
        this.initRasterizers();
    } else {
        this.mode = undefined;
        return;
    }
    this.generationTime = 0;
};

/**
 * Set up state in an existing gl context.
 * @return {boolean} Whether buffer initialization succeeded.
 */
Picture.prototype.setupGLState = function() {
    this.glManager = glStateManager(this.gl);

    console.log(this.glManager.availableExtensions);

    var useFloatRasterizer = (this.mode === 'webgl' ||
                              this.mode === 'no-texdata-webgl');
    if (useFloatRasterizer) {
        if (this.glManager.extensionTextureFloat === null) {
            return false;
        }
        if (this.mode === 'webgl') {
            this.glRasterizerConstructor = GLFloatTexDataRasterizer;
        } else {
            this.glRasterizerConstructor = GLFloatRasterizer;
        }
    } else {
        this.glRasterizerConstructor = GLDoubleBufferedRasterizer;
    }

    this.texBlitProgram = this.glManager.shaderProgram(blitShader.blitSrc,
                                                       blitShader.blitVertSrc,
                                                       {uSrcTex: 'tex2d'});
    this.texBlitUniforms = {
        uSrcTex: null
    };

    if (!this.initRasterizers()) {
        console.log('WebGL accelerated rasterizer did not pass sanity test ' +
                    '(mode ' + this.mode + '). Update your graphics drivers ' +
                    'or try switching browsers if possible.');
        return false;
    }
    return true;
};

/**
 * Add a buffer to the top of the buffer stack.
 * @param {number} id Identifier for this buffer. Unique at the Picture level.
 * Can be -1 if events won't be serialized separately from this buffer.
 * @param {Array.<number>} clearColor 4-component array with RGBA color that's
 * used to clear this buffer.
 * @param {boolean} hasUndoStates Does the buffer store undo states?
 * @param {boolean} hasAlpha Does the buffer have an alpha channel?
 */
Picture.prototype.addBuffer = function(id, clearColor, hasUndoStates,
                                       hasAlpha) {
    var buffer = this.createBuffer(id, clearColor, hasUndoStates, hasAlpha);
    this.buffers.push(buffer);
};

/**
 * Move a buffer to the given index in the buffer stack. Current buffer stays
 * attached to the moved buffer, if it exists.
 * @param {number} fromPosition The position of the buffer to move. Must be an
 * integer between 0 and Picture.buffers.length - 1.
 * @param {number} toPosition The position to move this buffer to. Must be an
 * integer between 0 and Picture.buffers.length - 1.
 */
Picture.prototype.moveBuffer = function(fromPosition, toPosition) {
    // TODO: assert that buffer count is respected
    var buffer = this.buffers[fromPosition];
    this.buffers.splice(fromPosition, 1);
    this.buffers.splice(toPosition, 0, buffer);
    if (this.currentBufferAttachment === fromPosition) {
        this.currentBufferAttachment = toPosition;
    }
};

/**
 * Attach the current buffer to the given buffer in the stack.
 * @param {number} attachment Which buffer index to attach the picture's current
 * buffer to. Can be set to -1 if no current buffer is needed.
 */
Picture.prototype.setCurrentBufferAttachment = function(attachment) {
    this.currentBufferAttachment = attachment;
    this.currentBuffer = (this.currentEvent !== null && attachment >= 0);
};

/**
 * Set one of this picture's buffers visible or invisible.
 * @param {PictureBuffer} buffer The buffer to adjust.
 * @param {boolean} visible Is the buffer visible?
 */
Picture.prototype.setBufferVisible = function(buffer, visible) {
    // TODO: assert that the buffer belongs to this picture.
    buffer.visible = visible;
};

/**
 * Create a Picture object.
 * @param {number} id Picture's unique id number.
 * @param {number} width Picture width.
 * @param {number} height Picture height.
 * @param {number} bitmapScale Scale for rasterizing the picture. Events that
 * are pushed to this picture get this scale applied to them.
 * @param {Array.<string>} modesToTry Modes to try to initialize the picture.
 * Can contain either 'webgl', 'no-texdata-webgl', 'no-float-webgl' or 'canvas'.
 * Modes are tried in the order they are in the array.
 * @param {number} currentBufferAttachment Which buffer index to attach the
 * picture's current buffer to. Can be set to -1 if no current buffer is needed.
 * @return {Picture} The created picture or null if one couldn't be created.
 */
Picture.create = function(id, width, height, bitmapScale, modesToTry,
                          currentBufferAttachment) {
    var pictureBounds = new Rect(0, width, 0, height);
    var i = 0;
    var pic = null;
    while (i < modesToTry.length && pic === null) {
        var mode = modesToTry[i];
        if (glUtils.supportsTextureUnits(4) || mode === 'canvas') {
            pic = new Picture(id, pictureBounds, bitmapScale, mode,
                              currentBufferAttachment);
            if (pic.mode === undefined) {
                pic = null;
            }
        }
        i++;
    }
    return pic;
};

/**
 * Create a picture object by parsing a serialization of it.
 * @param {number} id Unique identifier for the picture.
 * @param {string} serialization Serialization of the picture as generated by
 * Picture.prototype.serialize(). May optionally have metadata not handled by
 * the Picture object at the end, separated by line "metadata".
 * @param {number} bitmapScale Scale for rasterizing the picture. Events that
 * are pushed to this picture get this scale applied to them.
 * @param {Array.<string>} modesToTry Modes to try to initialize the picture.
 * Can contain either 'webgl', 'no-texdata-webgl', 'no-float-webgl' or 'canvas'.
 * Modes are tried in the order they are in the array.
 * @param {number} currentBufferAttachment Which buffer index to attach the
 * picture's current buffer to. Can be set to -1 if no current buffer is needed.
 * @return {Object} Object containing key 'picture' for the created picture and
 * key 'metadata' for the metadata lines or null if picture couldn't be created.
 */
Picture.parse = function(id, serialization, bitmapScale, modesToTry,
                         currentBufferAttachment) {
    var startTime = new Date().getTime();
    var eventStrings = serialization.split(/\r?\n/);
    var pictureParams = eventStrings[0].split(' ');
    var width = parseInt(pictureParams[1]);
    var height = parseInt(pictureParams[2]);
    var pic = Picture.create(id, width, height, bitmapScale, modesToTry,
                             currentBufferAttachment);
    var targetBuffer = null;
    var i = 1;
    while (i < eventStrings.length) {
        if (eventStrings[i] === 'metadata') {
            break;
        } else {
            var arr = eventStrings[i].split(' ');
            if (arr[0] === 'buffer') {
                var j = 1;
                var bufferId = parseInt(arr[j++]);
                var clearColor = [parseInt(arr[j++]),
                                  parseInt(arr[j++]),
                                  parseInt(arr[j++]),
                                  parseInt(arr[j++])];
                var hasUndoStates = arr[j++] === '1';
                var hasAlpha = arr[j++] === '1';
                var insertionPoint = parseInt(arr[j++]);
                pic.addBuffer(bufferId, clearColor, hasUndoStates, hasAlpha);
                targetBuffer = pic.buffers[pic.buffers.length - 1];
                targetBuffer.setInsertionPoint(insertionPoint);
            } else {
                var pictureEvent = PictureEvent.parse(arr, 0);
                pic.pushEvent(targetBuffer, pictureEvent);
            }
            ++i;
        }
    }
    var metadata = [];
    if (i < eventStrings.length && eventStrings[i] === 'metadata') {
        metadata = eventStrings.slice(i);
    }
    pic.generationTime = new Date().getTime() - startTime;
    return {picture: pic, metadata: metadata};
};

/**
 * @return {string} A serialization of this Picture. Can be parsed into a new
 * Picture by calling Picture.parse.
 */
Picture.prototype.serialize = function() {
    var serialization = ['picture ' + this.width() + ' ' + this.height()];
    for (var i = 0; i < this.buffers.length; ++i) {
        var buffer = this.buffers[i];
        serialization.push('buffer ' + buffer.id +
                           ' ' + color.serializeRGBA(buffer.clearColor) +
                           ' ' + (buffer.undoStates !== null ? '1' : '0') +
                           ' ' + (buffer.hasAlpha ? '1' : '0') +
                           ' ' + buffer.insertionPoint);
        for (var j = 0; j < buffer.events.length; ++j) {
            serialization.push(buffer.events[j].serialize());
        }
    }
    return serialization.join('\n');
};

/**
 * @param {HTMLCanvasElement} canvas Canvas to use for rasterization.
 * @return {WebGLRenderingContext} Context to use or null if unsuccessful.
 */
Picture.initWebGL = function(canvas) {
    var contextAttribs = {
        antialias: false,
        stencil: false,
        depth: false,
        premultipliedAlpha: true
    };
    var gl = glUtils.initGl(canvas, contextAttribs, 4);
    if (!gl) {
        return null;
    }

    gl.clearColor(1.0, 1.0, 1.0, 1.0);
    gl.disable(gl.DEPTH_TEST);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, canvas.width, canvas.height);
    return gl;
};

/**
 * @return {boolean} Does the picture use WebGL?
 */
Picture.prototype.usesWebGl = function() {
    return (this.mode === 'webgl' || this.mode === 'no-float-webgl' ||
            this.mode === 'no-texdata-webgl');
};

/**
 * Set a containing widget for this picture. The container is expected to add
 * what's returned from pictureElements() under a displayed HTML element.
 * @param {Object} container The container.
 */
Picture.prototype.setContainer = function(container) {
    this.container = container;
};

/**
 * @return {Array.<HTMLCanvasElement>} the elements that make up the display of
 * the rasterized picture.
 */
Picture.prototype.pictureElements = function() {
    return [this.canvas];
};

/**
 * Initialize rasterizers.
 * @return {boolean} True on success.
 * @protected
 */
Picture.prototype.initRasterizers = function() {
    this.currentBufferRasterizer = this.createRasterizer();
    if (!this.currentBufferRasterizer.checkSanity()) {
        this.currentBufferRasterizer.free();
        return false;
    }
    this.genericRasterizer = this.createRasterizer();
    return true;
};

/**
 * Create a single buffer using the mode specified for this picture.
 * @param {number} id Identifier for this buffer. Unique at the Picture level.
 * Can be -1 if events won't be serialized separately from this buffer.
 * @param {Array.<number>} clearColor 4-component array with RGBA color that's
 * used to clear this buffer.
 * @param {boolean} hasUndoStates Does the buffer store undo states?
 * @param {boolean} hasAlpha Does the buffer have an alpha channel?
 * @return {GLBuffer|CanvasBuffer} The buffer.
 * @protected
 */
Picture.prototype.createBuffer = function(id, clearColor, hasUndoStates,
                                          hasAlpha) {
    if (this.usesWebGl()) {
        return new GLBuffer(this.gl, this.glManager, this.texBlitProgram, id,
                            this.bitmapWidth(), this.bitmapHeight(),
                            clearColor, hasUndoStates, hasAlpha);
    } else if (this.mode === 'canvas') {
        return new CanvasBuffer(id, this.bitmapWidth(), this.bitmapHeight(),
                                clearColor, hasUndoStates, hasAlpha);
    }
};

/**
 * Create a single rasterizer using the mode specified for this picture.
 * @param {boolean=} saveMemory Choose a rasterizer that uses the least possible
 * memory as opposed to one that has the best performance. Defaults to false.
 * @return {BaseRasterizer} The rasterizer.
 */
Picture.prototype.createRasterizer = function(saveMemory) {
    if (saveMemory === undefined) {
        saveMemory = false;
    }
    if (this.glRasterizerConstructor !== undefined) {
        if (saveMemory) {
            return new GLDoubleBufferedRasterizer(this.gl, this.glManager,
                                                  this.bitmapWidth(),
                                                  this.bitmapHeight());
        } else {
            return new this.glRasterizerConstructor(this.gl, this.glManager,
                                                    this.bitmapWidth(),
                                                    this.bitmapHeight());
        }
    } else {
        return new Rasterizer(this.bitmapWidth(), this.bitmapHeight());
    }
};

/**
 * @return {number} The rasterizer bitmap width of the picture in pixels.
 */
Picture.prototype.bitmapWidth = function() {
    return this.bitmapRect.width();
};

/**
 * @return {number} The rasterizer bitmap height of the picture in pixels.
 */
Picture.prototype.bitmapHeight = function() {
    return this.bitmapRect.height();
};

/**
 * @return {number} The width of the picture.
 */
Picture.prototype.width = function() {
    return this.boundsRect.width();
};

/**
 * @return {number} The height of the picture.
 */
Picture.prototype.height = function() {
    return this.boundsRect.height();
};

/**
 * Add an event to the top of this picture. Bitmap rasterization scale is
 * applied to the event.
 * @param {GLBuffer|CanvasBuffer} targetBuffer The buffer of this picture to
 * apply the event to.
 * @param {PictureEvent} event Event to add.
 */
Picture.prototype.pushEvent = function(targetBuffer, event) {
    event.setDisplayScale(this.bitmapScale);
    this.transferEvent(targetBuffer, event);
};

/**
 * Add an event to the insertion point of the target buffer. Bitmap
 * rasterization scale is applied to the event.
 * @param {GLBuffer|CanvasBuffer} targetBuffer The buffer of this picture to
 * insert the event to.
 * @param {PictureEvent} event Event to insert.
 */
Picture.prototype.insertEvent = function(targetBuffer, event) {
    event.setDisplayScale(this.bitmapScale);
    targetBuffer.insertEvent(event, this.genericRasterizer);
};

/**
 * Transfer an event that has already been previously added to this picture to
 * a different buffer.
 * @param {GLBuffer|CanvasBuffer} targetBuffer The buffer of this picture to
 * apply the event to.
 * @param {PictureEvent} event Event to transfer.
 */
Picture.prototype.transferEvent = function(targetBuffer, event) {
    if (this.currentBufferRasterizer.drawEvent === event) {
        targetBuffer.pushEvent(event, this.currentBufferRasterizer);
    } else {
        targetBuffer.pushEvent(event, this.genericRasterizer);
    }
};

/**
 * Undo the latest event applied to this picture.
 * @param {number} sid The session id for which to undo the latest event which
 * has not yet been undone.
 * @return {PictureEvent} The event that was undone or null if no event found.
 */
Picture.prototype.undoLatest = function(sid) {
    var undoIndex = 0;
    var undoBufferIndex = 0;
    var latestId = -1;
    for (var i = 0; i < this.buffers.length; ++i) {
        var candidateIndex = this.buffers[i].findLatest(sid);
        if (candidateIndex >= 0 &&
            this.buffers[i].events[candidateIndex].sessionEventId > latestId) {
            undoBufferIndex = i;
            undoIndex = candidateIndex;
            latestId = this.buffers[i].events[undoIndex].sessionEventId;
        }
    }
    if (latestId >= 0) {
        return this.buffers[undoBufferIndex].undoEventIndex(undoIndex,
                                                        this.genericRasterizer);
    }
    return null;
};

/**
 * Undo the specified event applied to this picture.
 * @param {number} sid The session id of the event.
 * @param {number} sessionEventId The session-specific event id of the event.
 * @return {boolean} True on success.
 */
Picture.prototype.undoEventSessionId = function(sid, sessionEventId) {
    var j = this.buffers.length;
    while (j >= 1) {
       --j;
        var i = this.buffers[j].eventIndexBySessionId(sid, sessionEventId);
        if (i >= 0) {
            if (!this.buffers[j].events[i].undone) {
                this.buffers[j].undoEventIndex(i, this.genericRasterizer);
            }
            return true;
        }
    }
    return false;
};

/**
 * Redo the specified event applied to this picture by marking it not undone.
 * @param {number} sid The session id of the event.
 * @param {number} sessionEventId The session-specific event id of the event.
 * @return {boolean} True on success.
 */
Picture.prototype.redoEventSessionId = function(sid, sessionEventId) {
    var j = this.buffers.length;
    while (j >= 1) {
       --j;
        var i = this.buffers[j].eventIndexBySessionId(sid, sessionEventId);
        if (i >= 0) {
            this.buffers[j].redoEventIndex(i, this.genericRasterizer);
            return true;
        }
    }
    return false;
};

/**
 * Remove the specified event from this picture entirely.
 * @param {number} sid The session id of the event.
 * @param {number} sessionEventId The session-specific event id of the event.
 * @return {boolean} True on success.
 */
Picture.prototype.removeEventSessionId = function(sid, sessionEventId) {
    var j = this.buffers.length;
    while (j >= 1) {
       --j;
        var i = this.buffers[j].eventIndexBySessionId(sid, sessionEventId);
        if (i >= 0) {
            this.buffers[j].removeEventIndex(i, this.genericRasterizer);
            return true;
        }
    }
    return false;
};

/**
 * Update the currentBuffer of this picture, meant to contain the event that the
 * user is currently drawing. The event is assumed to already be in the picture
 * bitmap coordinates in pixels, not in the picture coordinates.
 * @param {PictureEvent} cEvent The event the user is currently drawing or null.
 */
Picture.prototype.setCurrentBuffer = function(cEvent) {
    this.currentBuffer = (cEvent !== null && this.currentBufferAttachment >= 0);
    this.currentEvent = cEvent;
    if (this.currentBuffer) {
        this.currentBufferRasterizer.setClip(this.bitmapRect);
        this.currentEvent.updateTo(this.currentBufferRasterizer);
        this.currentBufferMode = this.currentEvent.mode;
        if (this.currentBufferMode === BrushEvent.Mode.eraser &&
            !this.buffers[this.currentBufferAttachment].hasAlpha) {
            this.currentBufferMode = BrushEvent.Mode.normal;
        }
    }
};

/**
 * Search for event from sourceBuffer, remove it from there if it is found, and
 * push it to targetBuffer.
 * @param {PictureBuffer} targetBuffer The buffer to push the event to.
 * @param {PictureBuffer} sourceBuffer The buffer to search the event from.
 * @param {PictureEvent} event The event to transfer.
 */
Picture.prototype.moveEvent = function(targetBuffer, sourceBuffer, event) {
    var eventIndex = sourceBuffer.eventIndexBySessionId(event.sid,
                                                        event.sessionEventId);
    if (eventIndex >= 0) {
        sourceBuffer.removeEventIndex(eventIndex, this.genericRasterizer);
    }
    this.transferEvent(targetBuffer, event);
};

/**
 * Compile the compositing shader if needed and set compositing uniforms.
 * @protected
 */
Picture.prototype.setupGLCompositing = function() {
    this.compositingProgram = compositingShader.getShaderProgram(
                                  this.glManager,
                                  this.buffers,
                                  this.currentBufferAttachment,
                                  this.currentBufferMode,
                                  this.currentBufferRasterizer.format);

    this.compositingUniforms = {};
    for (var i = 0; i < this.buffers.length; ++i) {
        if (this.buffers[i].visible) {
            this.compositingUniforms['uLayer' + i] = this.buffers[i].tex;
            if (this.currentBufferAttachment === i) {
                this.compositingUniforms['uCurrentBuffer'] =
                    this.currentBufferRasterizer.getTex();
                if (this.currentBuffer) {
                    var color = this.currentEvent.color;
                    this.compositingUniforms['uCurrentColor'] =
                        [color[0] / 255, color[1] / 255, color[2] / 255,
                        this.currentEvent.opacity];
                } else {
                    this.compositingUniforms['uCurrentColor'] = [0, 0, 0, 0];
                }
            }
        }
    }
};

/**
 * Display the latest updated buffers of this picture. Call after doing changes
 * to any of the picture's buffers.
 */
Picture.prototype.display = function() {
    if (this.animating) {
        return;
    }
    if (this.usesWebGl()) {
        this.setupGLCompositing();
        this.glManager.useFbo(null);
        this.gl.scissor(0, 0, this.bitmapWidth(), this.bitmapHeight());
        this.glManager.drawFullscreenQuad(this.compositingProgram,
                                          this.compositingUniforms);
        this.gl.flush();
    } else {
        if (this.buffers.length === 0 || this.buffers[0].hasAlpha ||
            !this.buffers[0].visible) {
            this.ctx.clearRect(0, 0, this.bitmapWidth(), this.bitmapHeight());
        }
        for (var i = 0; i < this.buffers.length; ++i) {
            if (this.buffers[i].visible) {
                if (this.currentBufferAttachment === i && this.currentBuffer &&
                    this.currentEvent.boundingBox !== null) {
                    if (this.buffers[i].hasAlpha) {
                        this.compositingCtx.clearRect(0, 0, this.bitmapWidth(),
                                                      this.bitmapHeight());
                    }
                    this.compositingCtx.drawImage(this.buffers[i].canvas, 0, 0);
                    var clipRect = new Rect(0, this.bitmapWidth(),
                                            0, this.bitmapHeight());
                    clipRect.intersectRect(this.currentEvent.boundingBox);
                    CanvasBuffer.drawRasterizer(this.buffers[i].ctx,
                                                this.compositingCtx,
                                                this.currentBufferRasterizer,
                                                clipRect,
                                                false,
                                                this.currentEvent.color,
                                                this.currentEvent.opacity,
                                                this.currentBufferMode);
                    this.ctx.drawImage(this.compositingCanvas, 0, 0);
                } else {
                    this.ctx.drawImage(this.buffers[i].canvas, 0, 0);
                }
            }
        }
    }
};

/**
 * Play back an animation displaying the progress of this picture from start to
 * finish.
 * @param {number} simultaneousStrokes How many subsequent events to animate
 * simultaneously. Must be at least 1.
 * @param {number} speed Speed at which to animate the individual events. Must
 * be between 0 and 1.
 * @param {function()=} animationFinishedCallBack Function to call when the
 * animation has finished.
 * @return {boolean} Returns true if the animation was started or is still in
 * progress from an earlier call.
 */
Picture.prototype.animate = function(simultaneousStrokes, speed,
                                     animationFinishedCallBack) {
    if (!this.supportsAnimation()) {
        return false;
    }
    if (this.animating) {
        return true;
    }
    var that = this;
    this.animating = true;
    if (this.buffers.length === 0) {
        setTimeout(function() {
            that.animating = false;
            if (animationFinishedCallBack !== undefined) {
                animationFinishedCallBack();
            }
        }, 0);
        return true;
    }
    if (speed === undefined) {
        speed = 0.05;
    }
    this.animationSpeed = speed;

    this.totalEvents = 0;
    this.animationBuffers = [];
    // TODO: Currently playback is from bottom to top. Switch to a
    // timestamp-based approach.
    for (var i = 0; i < this.buffers.length; ++i) {
        this.totalEvents += this.buffers[i].events.length;
        var buffer = this.createBuffer(-1, this.buffers[i].clearColor,
                                       false, this.buffers[i].hasAlpha);
        this.animationBuffers.push(buffer);
    }
    this.animationRasterizers = [];
    this.animationEventIndices = [];

    simultaneousStrokes = Math.min(simultaneousStrokes, this.totalEvents);
    var j = -1;
    this.eventToAnimate = function(index) {
        for (var i = 0; i < that.buffers.length; ++i) {
            if (index < that.buffers[i].events.length) {
                return {event: that.buffers[i].events[index], bufferIndex: i};
            } else {
                index -= that.buffers[i].events.length;
            }
        }
        return null; // should not be reached
    };

    function getNextEventIndexToAnimate() {
        ++j;
        while (j < that.totalEvents && that.eventToAnimate(j).event.undone) {
            ++j;
        }
        var bufferIndex = 0;
        var eventToAnimate = that.eventToAnimate(j);
        if (eventToAnimate !== null) {
            bufferIndex = eventToAnimate.bufferIndex;
        }
        return {index: j, bufferIndex: bufferIndex};
    };

    for (var i = 0; i < simultaneousStrokes; ++i) {
        this.animationRasterizers.push(this.createRasterizer(true));
        this.animationEventIndices.push(getNextEventIndexToAnimate());
    }

    var animationPos = 0;
    var animationFrame = function() {
        if (!that.animating) {
            return;
        }
        var finishedRasterizers = 0;
        var animationPosForStroke = animationPos;
        animationPos += that.animationSpeed;
        for (var i = 0; i < simultaneousStrokes; ++i) {
            animationPosForStroke -= 1.0 / simultaneousStrokes;
            var eventIndex = that.animationEventIndices[i].index;
            if (eventIndex < that.totalEvents) {
                if (animationPosForStroke > 0) {
                    var eventToAnimate = that.eventToAnimate(eventIndex);
                    var bufferIndex = eventToAnimate.bufferIndex;
                    var event = eventToAnimate.event;
                    var untilPos = (animationPosForStroke % 1.0) +
                                   that.animationSpeed;
                    if (untilPos > 1.0) {
                        that.transferEvent(that.animationBuffers[bufferIndex],
                                           event);
                        that.animationEventIndices[i] =
                            getNextEventIndexToAnimate();
                        that.animationRasterizers[i].clear();
                    } else {
                        var untilCoord = event.coords.length * untilPos;
                        untilCoord = Math.ceil(untilCoord / 3) * 3;
                        event.updateTo(that.animationRasterizers[i],
                                       untilCoord);
                    }
                }
            } else {
                if (that.animationRasterizers[i] !== null) {
                    that.animationRasterizers[i].free();
                    that.animationRasterizers[i] = null;
                }
                ++finishedRasterizers;
            }
        }
        if (finishedRasterizers !== simultaneousStrokes) {
            that.displayAnimation();
            requestAnimationFrame(animationFrame);
        } else {
            that.stopAnimating();
            if (animationFinishedCallBack !== undefined) {
                animationFinishedCallBack();
            }
        }
    };
    requestAnimationFrame(animationFrame);
    return true;
};

/**
 * Stop animating if animation is in progress.
 */
Picture.prototype.stopAnimating = function() {
    if (this.animating) {
        this.animating = false;
        var i;
        for (i = 0; i < this.animationRasterizers.length; ++i) {
            if (this.animationRasterizers[i] !== null) {
                this.animationRasterizers[i].free();
                this.animationRasterizers[i] = null;
            }
        }
        for (i = 0; i < this.animationBuffers.length; ++i) {
            this.animationBuffers[i].free();
        }
        this.animationBuffers = null;
        this.eventToAnimate = null;
        this.display();
    }
};

/**
 * @return {boolean} Does this picture support animation?
 */
Picture.prototype.supportsAnimation = function() {
    return this.usesWebGl();
};

/**
 * Display the current animation frame on the canvas.
 * @protected
 */
Picture.prototype.displayAnimation = function() {
    // TODO: Improve compositing shader so that it can be used for animation
    this.glManager.useFbo(null);
    this.gl.scissor(0, 0, this.bitmapWidth(), this.bitmapHeight());
    var i, j;
    var rasterizerIndexOffset = 0;
    for (i = 0; i < this.animationRasterizers.length; ++i) {
        if (this.animationEventIndices[i].index <
            this.animationEventIndices[rasterizerIndexOffset].index) {
            rasterizerIndexOffset = i;
        }
    }
    for (i = 0; i < this.animationBuffers.length; ++i) {
        this.texBlitUniforms.uSrcTex = this.animationBuffers[i].tex;
        this.glManager.drawFullscreenQuad(this.texBlitProgram,
                                          this.texBlitUniforms);
        for (j = 0; j < this.animationRasterizers.length; ++j) {
            // Start from the rasterizer that's first in the bottom-to-top order
            var ri = (j + rasterizerIndexOffset) %
                                  this.animationRasterizers.length;
            if (this.animationEventIndices[ri].index < this.totalEvents &&
                this.animationEventIndices[ri].bufferIndex === i) {
                var event = this.eventToAnimate(
                                this.animationEventIndices[ri].index).event;
                if (event.mode !== BrushEvent.Mode.eraser) {
                    this.animationRasterizers[ri].drawWithColor(event.color,
                                                               event.opacity);
                }
            }
        }
    }
    this.gl.flush();
};

/**
 * Return objects that contain events touching the given pixel. The objects
 * have two keys: event, and alpha which determines that event's alpha value
 * affecting this pixel. The objects are sorted from newest to oldest.
 * @param {Vec2} coords Position of the pixel in bitmap coordinates.
 * @return {Array.<Object>} Objects that contain events touching this pixel.
 */
Picture.prototype.blamePixel = function(coords) {
    var blame = [];
    var j = this.buffers.length;
    while (j >= 1) {
        --j;
        if (this.buffers[j].events.length > 0) {
            var bufferBlame = this.buffers[j].blamePixel(coords);
            if (bufferBlame.length > 0) {
                blame = blame.concat(bufferBlame);
            }
        }
    }
    return blame;
};

/**
 * Get a pixel from the composited picture. Displays the latest changes to the
 * picture as a side effect.
 * @param {Vec2} coords Position of the pixel in bitmap coordinates.
 * @return {Uint8Array|Uint8ClampedArray} Unpremultiplied RGBA value.
 */
Picture.prototype.getPixelRGBA = function(coords) {
    if (this.usesWebGl()) {
        this.display();
        var buffer = new ArrayBuffer(4);
        var pixelData = new Uint8Array(buffer);
        var glX = Math.min(Math.floor(coords.x), this.bitmapWidth() - 1);
        var glY = Math.max(0, this.bitmapHeight() - 1 - Math.floor(coords.y));
        this.gl.readPixels(glX, glY, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE,
                           pixelData);
        pixelData = color.unpremultiply(pixelData);
        return pixelData;
    } else {
        var c = [0, 0, 0, 0];
        for (var j = 0; j < this.buffers.length; ++j) {
            if (this.buffers[j].visible && this.buffers[j].events.length > 0) {
                c = color.blend(c, this.buffers[j].getPixelRGBA(coords));
            }
        }
        return c;
    }
};

/**
 * Generate a data URL representing this picture. Displays the latest changes to
 * the picture as a side effect.
 * @return {string} PNG data URL representing this picture.
 */
Picture.prototype.toDataURL = function() {
    this.display();
    return this.canvas.toDataURL();
};