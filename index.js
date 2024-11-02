import express from 'express';
import path from 'path';
import session from 'express-session';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { prompt, hashPassword, deriveKey } from './util.js';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import winston from 'winston';
import cors from 'cors';
import fs from 'fs';
import bodyParser from 'body-parser'
import {Server, Socket} from 'socket.io';
import expressSocketIO from 'express-socket.io-session';
import http, { request } from 'http';
import { render } from 'ejs';
import multer from 'multer';



const db = new Database('database/database.db');

// Ask for the password at the start of the server
const password = await prompt('Enter your password: ');

// Hash the password using SHA-512
const hashedPassword = hashPassword(password);
//const IV = Buffer.from([0x0d, 0x90, 0x71, 0x24, 0x0d, 0xa0, 0x78, 0x54, 0xce, 0xea, 0x90, 0x93, 0x34, 0x5b, 0xc8, 0x62]);
// Derive the encryption key from the hashed password
const encryptionKey = deriveKey(hashedPassword);

//console.log(encryptionKey);
// Now I can interact with the database mwahahahahaa

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = 2000;
const topics = {0: "general"}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
let validAuthTokens = [];
let requestTokens = {};
const logPath = "app.log";
let usernameToId = {}
let roomNameToId = {}

const storage = multer.memoryStorage(); // Store files in memory as Buffer
const upload = multer({ storage: storage });

// Set strong CSP policies
const cspPolicy = {
    directives: {
        defaultSrc: ["'self'"], // Only allow resources from the same origin
        scriptSrc: [
            "'self'",
            "'unsafe-eval'", // Allow eval for WebAssembly, ig
            "https://cdnjs.cloudflare.com", // Allow scripts from the domain
            // + Specific hashes for inline scripts if necessary
        ],
        objectSrc: ["'none'"], // Disallow all plugins like Flash
        baseUri: ["'self'"], // Only allow base tag to point to the domain
        formAction: ["'self'"], // Forms can only submit to the domain
        frameAncestors: ["'none'"], // Prevent the page from being framed
        upgradeInsecureRequests: [], // Automatically upgrade HTTP requests to HTTPS
        blockAllMixedContent: [], // Block mixed content (HTTP on HTTPS pages)
        reportUri: "/csp-violation-report", // this line for reporting
    },
};

// Define custom logging levels
const customLevels = {
    levels: {
        csp_violation: 0,
        fatal: 0,  // Critical system errors
        error: 1,  // Regular errors
        warn: 2,   // Warnings
        info: 3,   // General info messages
        verbose: 4, // More detailed messages
        debug: 5,  // Debugging information
        trace: 6   // Very detailed tracing information
    },
    colors: {
        csp_violation: 'red',
        fatal: 'red',
        error: 'red',
        warn: 'yellow',
        info: 'green',
        verbose: 'cyan',
        debug: 'blue',
        trace: 'magenta'
    }
};

// Create the logger with custom levels
const logger = winston.createLogger({
    levels: customLevels.levels,
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            const encrypted = encrypt(message); // Encrypt the message
            return `${timestamp} [${level}]: ${JSON.stringify(encrypted)}`; // Log the encrypted message
        })
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(), // Colorize console output
                winston.format.timestamp(), // Include timestamp
                winston.format.printf(({ timestamp, level, message }) => {
                    //const encrypted = encrypt(message);
                    return `${timestamp} [${level}]: ${message}`;
                })
            )
        }),
        new winston.transports.File({ filename: 'app.log' }) // Log to a file
    ],
});

// Add custom colors to the console
winston.addColors(customLevels.colors);















function updateUsernameToId() {
    const stmt = db.prepare("SELECT * FROM users;");
    const result = stmt.all();
    for (let user of result) {
        usernameToId[decrypt(user.username)] = user.id;
    }
}

function updateRoomToId() {
    const stmt = db.prepare("SELECT * FROM rooms;");
    const result = stmt.all();
    for (let room of result) {
        roomNameToId[decrypt(room.title)] = room.id;
    }
}





/**
 * Encrypt data using AES-256-CBC with a random IV.
 * @param {string} data - The plaintext data to encrypt.
 * @returns {string} - The IV + encrypted ciphertext in hex format.
 */
function encrypt(data) {
    // Generate a random IV for each encryption
    const IV = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, IV);

    let encrypted = cipher.update(data, 'utf-8', 'hex');
    encrypted += cipher.final('hex');

    // Prepend IV to the encrypted result
    const ivHex = IV.toString('hex');
    return ivHex + encrypted;
}

/**
 * Decrypt data using AES-256-CBC with the IV stored in the ciphertext.
 * @param {string} encryptedData - The IV + encrypted data in hex format.
 * @returns {string} - The decrypted plaintext.
 */
function decrypt(encryptedData) {
    // Extract IV from the beginning of the encrypted data
    const ivHex = encryptedData.slice(0, 32); // First 32 hex characters (16 bytes)
    const IV = Buffer.from(ivHex, 'hex');
    
    // Extract the actual ciphertext
    const ciphertext = encryptedData.slice(32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', encryptionKey, IV);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');

    return decrypted;
}

/**
 * Get the public key from a user_id
 * @param {int} user_id the user id of who you want to get the public key
 * @returns public key, string. Except if the user doesnt exist: -1
 */
function getPublicKey(user_id) {
    console.log(user_id)
    console.log("GETTING THE ABOVE PUBLIC KEY!!!!!!!")
    const stmt = db.prepare(`SELECT public_key FROM users WHERE id = ?`);
    const result = stmt.get(user_id);
    return result ? result.public_key : -1
}

/**
 * is a string real or is it the square root of -1 ? That is the question
 * @param {string} value just checks if a variable is a string and not empty.
 * @returns 
 */
function isItReal(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function getUser(user_id) {
    const stmt = db.prepare(`SELECT * FROM users WHERE id = ?`);
    return stmt.get(user_id);
}

function setPfp(user_id, pfp_base64) {
    const stmt = db.prepare(`UPDATE users SET pfp = ? WHERE id = ?`); // Removed "TABLE"
    return stmt.run(pfp_base64, user_id);
}


/**
 * Get all logs.
 * @returns logs [DECRYPTED]
 */
function getAllDecryptedLogs() {
    try {
        // Read the log file
        const logData = fs.readFileSync(logPath, 'utf8');

        // Split log entries (assuming each entry is on a new line)
        const logEntries = logData.split('\n').filter(Boolean); // Filter out any empty lines
        let log = []
        for (let entry of logEntries) {
            const split_ = entry.split(" ");
            const time = split_[0];
            const type = split_[1];
            console.log(split_);
            const data_encrypted = split_[2].replace("\"", "").replace("\"", "");
            console.log(data_encrypted);
            const data_decrypted = decrypt(data_encrypted);
            console.log(data_decrypted)
            log.push(`${time} ${type} ${data_decrypted}`);
        }

        // Filter out any null values from decryption failures
        return log; 
    } catch (error) {
        console.error('Error reading log file:', error);
        return []; // Return an empty array if there's an error
    }
}

function deleteRoom(roomId) {
    const stmt = db.prepare(`DELETE FROM rooms WHERE id = ?`);
    stmt.run(roomId);
    const stmt2 = db.prepare(`DELETE FROM messages WHERE room_id = ?`);
    stmt2.run(roomId);
    return 1;
}

function addMessageDebug(user_id_from, user_id_to, content) {
    const username_from = getUsernameById(user_id_from);
    const username_to = getUsernameById(user_id_to);

    const receiver_public_key = getPublicKey(user_id_to);
    
    const encrypted_username_from = encrypt(username_from);
    const encrypted_username_to = encrypt(username_to);
    const encrypted_content = encrypt(content);
    let users;
    if (user_id_from > user_id_to) {
        users = `${user_id_to},${user_id_from}`;
    } else {
        users = `${user_id_from},${user_id_to}`;
    }
}

/**
 * Add a message to the database. Message content should be encrypted with the server symmetrical key prior to being added.
 * @param {int} user_id_from the id of the user who is sending the message
 * @param {int} user_id_to the id of the user who is receiving the message
 * @param {string} sender_content the sender content (the content of the message, encrypted with the public key of the sender). This function expects it to already be encrypted with the server symmetrical key.
 * @param {string} receiver_content the receiver content (the content of the message, encrypted with the public key of the receiver). This function expects it to already be encrypted with the server symmetrical key.
 * @param {string} signature the signature of the message. (The signed sha256 hash of the message, signed by sender.) This function expects it to already be encrypted with the server symmetrical key.
 * @returns result of SQL query
 */
function createMessage(user_id_from, user_id_to, sender_content, receiver_content, signature) {
    const username_from = getUsernameById(user_id_from);
    const username_to = getUsernameById(user_id_to);
    
    const encrypted_username_from = encrypt(username_from);
    const encrypted_username_to = encrypt(username_to);
    // Its encrypted in the socket code
    const encrypted_sender_content = sender_content;
    const encrypted_receiver_content = receiver_content;
    const encrypted_signature = signature;

    let users;
    if (user_id_to > user_id_from) {
        users = `${user_id_to},${user_id_from}`;
    } else {
        users = `${user_id_from},${user_id_to}`;
    }
    const stmt = db.prepare(`INSERT INTO direct_messages (user_id_from, username_from, user_id_to, username_to, sender_content, receiver_content, users, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    return stmt.run(user_id_from, encrypted_username_from, user_id_to, encrypted_username_to, encrypted_sender_content, encrypted_receiver_content, users, encrypted_signature);

}

/**
 * Get messages between two users. Encrypted
 * @param {string} users comma seperated list of user ids - bigger one first. Used to identify direct messages.
 * @returns list of messages which have the `users` attribute of your argument
 */
function getMessages(users) {
    const stmt = db.prepare(`SELECT * FROM direct_messages WHERE users = ?`);
    return stmt.all(users);
}

/**
 * Get posts from a specified topic_id and with an order
 * @param {int} topic_id int indicating topic_id in database. Defaults to 0 (general)
 * @param {order} order sorting order. Defaults to "ORDER BY aura DESC" (top aura at top)
 * @returns Result of SQL query
 */
async function getPosts(topic_id, order="desc_aura") {
    console.log(topic_id, order)
    let order_suffix;
    // Times ascending = oldest to newest
    switch (order) {
        case "desc_aura":
            order_suffix = "ORDER BY aura DESC";
            break;
        case "asc_aura":
            order_suffix = "ORDER BY aura ASC";
            break;
        case "latest":
            order_suffix = "ORDER BY time_created DESC";
            break;
        case "oldest":
            order_suffix = "ORDER BY time_created ASC";
            break;
        default:
            order_suffix = "ORDER BY aura DESC";
            break;
    }
    const query = `SELECT * FROM posts WHERE topic_id = ? ${order_suffix}`;
    console.log(query);
    console.log(topic_id);
    const stmt = db.prepare(query);
    console.log(stmt);
    return stmt.all(topic_id);
    
}

/**
 * Get users from the database. Returns encrypted data.
 * @returns {Array}  List of users. [ENCRYPTED]
 */
async function getUsers() {
    const stmt = db.prepare("SELECT * FROM users;");
    const result = await stmt.all();
    return result;
}

/**
 * Create user. Will automatically encrypt data..
 * @param {string} username - Username for new user.
 * @param {string} password - Plaintext password for new user. Will be hashed automatically.
 * @param {boolean} admin - Boolean indicating whether the user is an admin
 * @returns {string} The result of the SQL query.
 */
async function createUser(username, password, admin, about="", public_key="", global=1, pfp="", tags="", email="") {
    if (pfp == "") {
    fs.readFile("public/images/image.png", (err, data) => {
        if (err) {
            console.error('Error reading the file:', err);
            return;
        }
    
        // Convert to Base64
        const base64String = data.toString('base64');
        pfp = 
        console.log(base64String); // Logs the Base64 string
    });
    }
    const hashedPassword = await bcrypt.hash(password, 10);  // Hash the password
    const encryptedUsername = encrypt(username);
    const encryptedPassword = encrypt(hashedPassword);
    const encryptedAbout = about != "" ? encrypt(about) : "";
    const encryptedPublicKey = public_key != "" ? encrypt(public_key) : "";
    const encryptedTags = tags != "" ? encrypt(tags) : "";
    const encryptedEmail = email != "" ? encrypt(email) : "";


    //console.log(encryptedUsername, encryptedPassword);
    const stmt = db.prepare('INSERT INTO users (username, password, admin, aura, about, public_key, global, pfp, tags, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    return stmt.run(encryptedUsername, encryptedPassword, admin, 0, encryptedAbout, encryptedPublicKey, global, pfp, encryptedTags, encryptedEmail).lastInsertRowid;
}
/**
 * 
 * @param {int} roomId the id of the room who's messages you want
 * @returns 
 */
function getMessagesRoom(roomId) {
    const stmt = db.prepare(`SELECT * FROM messages WHERE room_id = ?`);
    return stmt.all(roomId);
}

/**
 * 
 * @param {int} roomId The id of the room
 * @param {string} content the content of the message (THE FUNCTION EXPECTS IT TO BE PRE-ENCRYPTED)
 * @param {int} user_id The id of the user who created the message
 * @returns 
 */
function createMessageRoom(roomId, content, user_id) {
    const stmt = db.prepare(`INSERT INTO messages (content, user_id, room_id) VALUES (?, ?, ?)`);
    return stmt.run(content, user_id, roomId)
}

/**
 * Add a public key to an account
 * @param {int} user_id user id of the account to which you are adding a public key
 * @param {int} public_key the public key. Copy and pasted from /generateKeypair
 * @returns result of sql query, and -1 if it fails
 */
async function addPublicKey(user_id, public_key) {
    const encryptedPublicKey = isItReal(public_key) ? encrypt(public_key) : "";
    if (encryptedPublicKey === "") {
        return -1; // Exit the function if encryptedPublicKey is an empty string
    }
    const stmt = db.prepare(`UPDATE users SET public_key=? WHERE id = ?`);
    return stmt.run(encryptedPublicKey, user_id);
}

/**
 * Get chat rooms
 * @returns result of SQL query [ENCRYPTED]
 */
async function getRooms() {
    const stmt = db.prepare("SELECT * FROM rooms");
    return stmt.all();
}

/**
 * Create a chatroom
 * @param {string} title title of chatroom
 * @param {string} password plaintext password for the room
 * @returns 
 */
async function createRoom(title, password="", locked=0) {
    const encryptedTitle = encrypt(title);
    // SHA-512
    const hashedPassword = password == "" ? "" : await hashPassword(password);
    const encryptedHashedPassword = hashedPassword == "" ? "" : await encrypt(hashedPassword);
    const stmt = db.prepare(`INSERT INTO rooms (title, password, locked) VALUES (?, ?, ?)`);
    stmt.run(encryptedTitle, encryptedHashedPassword, locked).lastInsertRowid;

    const stmt1 = db.prepare(`SELECT id from rooms WHERE title = ?`)
    const room = stmt1.get(encryptedTitle);
    return room ? room.id : -1;
}

/**
 * Create a topic
 * @param {string} title Title of the topic to be created
 * @returns result of SQL query
 */
async function createTopic(title) {
    const encryptedTitle = encrypt(title);
    const stmt = db.prepare("INSERT INTO topics (title, amount) VALUES (?, ?)");
    return stmt.run(encryptedTitle, 0);
}

/**
 * Get post data by id.
 * @param {string} postId - The id of the post which you are looking for.
 * @returns {string} The post data (if the SQL doesn't fail).[ENCRYPTED]
 */
function getPostById(postId) {
    console.log("getting post "+postId)
    const stmt = db.prepare('SELECT * FROM posts WHERE id = ?');
    return stmt.get(postId); // Returns a single post as an object
}

/**
 * Get comment data by id.
 * @param {string} commentId - The id of the comment which you are looking for.
 * @returns {string} The comment data (if the SQL doesn't fail).[ENCRYPTED]
 */
function getCommentById(commentId) {
    console.log("using funciton")
    const stmt = db.prepare('SELECT * FROM comments WHERE id = ?');
    console.log("result: ")
    const result = stmt.get(commentId); // Returns a single post as an object
    console.log(result);
    return result;
}

/**
 * Get room title from its id
 * @param {int} roomId The id of the room
 * @returns title of room or -1
 */
function getRoomTitleById(roomId) {
    const stmt = db.prepare('SELECT title FROM rooms WHERE id = ?');
    const room = stmt.get(roomId);
    return room ? room.title : -1;    
}

/**
 * Get room data from its id
 * @param {int} roomId The id of the room
 * @returns data of room or -1
 */
function getRoomData(roomId) {
    const stmt = db.prepare('SELECT * FROM rooms WHERE id = ?');
    const room = stmt.get(roomId);
    return room ? room : -1;    
}

/**
 * Get a users username from his id.
 * @param {string} userId - The id of the desired user.
 * @returns {string} The username. [ENCRYPTED]
 */
function getUsernameById(userId) {
    const stmt = db.prepare('SELECT username FROM users WHERE id = ?');
    const user = stmt.get(userId);
    return user ? user.username : null;
}

/**
 * Get an id from a username
 * @param {string} username username of the person who's id you want
 * @returns the id (int) or null if the user doesnt exist
 */
function getIdByUsername(username) {
    const encryptedUsername = encrypt(username);
    const stmt = db.prepare('SELECT id FROM users WHERE username = ?');
    const user = stmt.get(encryptedUsername);
    return user ? user.id : null;
}

/**
 * Gets a users aura from his id.
 * @param {string} userId - The id of the desired user.
 * @returns {string} The aura. [ENCRYPTED]
 */
function getAuraById(userId) {
    const stmt = db.prepare('SELECT aura FROM users WHERE id = ?');
    const user = stmt.get(userId);
    return user ? user.aura : null;
}

/**
 * Gets comments with specified post_id and order
 * @param {int} post_id id of the post for which you are getting comments to
 * @param {string} order how the comments should be sorted
 * @returns result of SQL query
 */
function getComments(post_id, order="aura_desc") {
    let order_suffix;
    // Times ascending = oldest to newest
    switch (order) {
        case "aura_desc":
            order_suffix = "ORDER BY aura DESC";
        case "aura_asc":
            order_suffix = "ORDER BY aura ASC";
        case "latest":
            order_suffix = "ORDER BY time_created DESC";
        case "oldest":
            order_suffix = "ORDER BY time_created ASC";
        default:
            order_suffix = "ORDER BY aura DESC";
    }
    const query = `SELECT * FROM comments WHERE post_id = ? ${order_suffix}`;
    const stmt = db.prepare(query);
    return stmt.all(post_id);
}

/**
 * Add or subtract aura from a user.
 * @param {string} userId - The id of the target user.
 * @param {int} amout - The amount of aura
 * @returns {boolean} true/false depending on success.
 */
function plusMinusAura(userId, amount) {
    const currentAura = getAuraById(userId);
    console.log(currentAura);
    if (currentAura === null) return false;

    const newAura = currentAura + amount;
    const updateStmt = db.prepare('UPDATE users SET aura = ? WHERE id = ?');
    return updateStmt.run(newAura, userId).changes > 0; // Returns true if the update succeeded
}

/**
 * Vote on a piece of content.
 * @param {int} id - The id of the target piece of content.
 * @param {string} userId - The id of the author (user).
 * @param {string} action - "up"/"down" depending on upvote/downvote
 * @param {string} type - "post"/"comment" 
 * @returns {string} The result of the SQL query.
 */
async function voteContent(id, userId, action, type) {
    let content;
    if (type == 'post') {

        content = await getPostById(id);
    } else if (type == 'comment') {
        console.log("getting comment")
        content = await getCommentById(id); // Assuming getCommentById is implemented
    } else {
        console.log("Type dont match: " + type)
    }
    console.log("CONTENT:\n" + content)

    if (!content) return false;

    const votedUsers = content.voted_user_ids ? content.voted_user_ids.split(',') : [];
    console.log(votedUsers);
    if (votedUsers.includes(String(userId))) return false; // Already voted
    console.log("not voted yet");

    // Calculate new content aura
    const newAura = action === 'up' ? content.aura + 1 : content.aura - 1;
    plusMinusAura(userId, action === 'up' ? 1 : -1); // Adjust user aura (giving the poster aura)

    votedUsers.push(String(userId));
    const updatedVotedUsers = votedUsers.join(',');

    const table = type === 'post' ? 'posts' : 'comments';
    const stmt = db.prepare(`UPDATE ${table} SET aura = ?, voted_user_ids = ? WHERE id = ?`);
    console.log(stmt);
    const result = stmt.run(newAura, updatedVotedUsers, id).changes > 0;
    console.log(result);
}

/**
 * Create a post.
 * @param {string} title The title of the post.
 * @param {int} topicId The (numerical) id of the topic.
 * @param {int} userId The (numerical) id of the author (user).
 * @param {string} content The content of the post.
 * @param {string} tags The tags attached to the post (comma seperated list).
 * @returns {string} The result of the SQL query.
 */
function createPost(title, topicId, userId, content, tags) {
    const encryptedTitle = encrypt(title);
    const encryptedContent = encrypt(content);
    const encryptedTags = encrypt(tags);

    const stmt = db.prepare(`
        INSERT INTO posts (title, topic_id, user_id, content, tags, aura, voted_user_ids)
        VALUES (?, ?, ?, ?, ?, 0, '')
    `);
    return stmt.run(encryptedTitle, topicId, userId, encryptedContent, encryptedTags).lastInsertRowid;
}

/**
 * 
 * @param {int} postId The (numerical) id of the parent post.
 * @param {int} userId The (numerical) id of the author (user).
 * @param {string} content The content of the comment.
 * @returns {string} The result of the SQL query.
 */
function createComment(postId, userId, content) {
    const encryptedContent = encrypt(content)
    const stmt = db.prepare(`
        INSERT INTO comments (post_id, user_id, content, aura, voted_user_ids)
        VALUES (?, ?, ?, 0, '')
    `);
    return stmt.run(postId, userId, encryptedContent).lastInsertRowid;
}

/**
 * 
 * @param {int} severity Level of severity.
 * 0: debug
 * 1: info_unimportant
 * 2: info_important
 * 3: issue 
 * 4: critical_issue 
 * 5: CSP violation
 * @param {string} title Title of message
 * @param {string} content Content of message
 */














// Setting up server
app.set('view engine', 'ejs');
app.use(express.static(__dirname + '/public'));
app.set('views', path.join(__dirname, '/public/views'));
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.json()); // Make sure this is before your routes

app.use(helmet.contentSecurityPolicy(cspPolicy));
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
})
app.use(sessionMiddleware);

io.use(expressSocketIO(sessionMiddleware, {
    autoSave: true // Save session changes automatically
}));


















// Routes

app.post("/test", (req, res) => {
    console.log(req.body);
});

// Reporting endpoint for CSP violations
app.post('/csp-violation-report', (req, res) => {
    const cspReport = req.body['csp-report'] || req.body; // Ensure we access the right structure
    logger.csp_violation('CSP Violation Report:', {
        documentUri: cspReport['document-uri'],
        referrer: cspReport.referrer,
        blockedUri: cspReport['blocked-uri'],
        violatedDirective: cspReport['violated-directive'],
        originalPolicy: cspReport['original-policy'],
    }); // Log specific details from the violation report
    res.sendStatus(204); // Respond with no content status
});

app.get("/createPost", (req, res) => {
    if (req.session.username) {
        const message = req.query.message || "";
        res.render("create_post.ejs", { message });
    } else {
        res.redirect("/login");
    }
});

app.get("/", (req, res) => {
    const referer = req.get('Referer');
    console.log(referer);
    if (req.session.admin) {
        try {
            const logs = getAllDecryptedLogs();
            res.render("main_admin.ejs", { log: JSON.stringify(logs, null, 2), data: req.session });
        } catch (error) {
            console.error("Error retrieving logs:", error);
            res.redirect("/login?message=Error retrieving logs");
        }
    } else if (req.session.username) {
        res.render("main.ejs", { data: req.session });
    } else {
        res.redirect("/login");
    }
});

app.get("/login", (req, res) => {
    if (req.session.username) {
        res.redirect("/");
    } else {
        res.render("login.ejs", { message: req.query.message || "" });
    }
});

app.get("/generateKeypair", (req, res) => {
    res.render("generate_keypair");
});

app.get("/voteContent", (req, res) => {
    if (!req.session.username) {
        res.redirect("/login");
        return;
    }
    
    const { type = "", vote = "", id = "", post_id = "" } = req.query;
    
    if (!type || !vote || !id || !post_id) {
        res.redirect("/forum?message=an+error+occured");
        return;
    }
    
    const result = voteContent(id, req.session.user_id, vote, type);
    if (!result) {
        res.redirect("/forum?message=Youve+already+voted+on+that+piece+of+content.");
    } else {
        res.redirect(`/post?id=${post_id}`);
    }
});

app.get("/forum", async (req, res) => {
    if (!req.session.username) {
        res.redirect("/login");
        return;
    }
    
    const topic_id = req.query.topic_id || 0;
    const order = req.query.order || "desc_aura";
    const message = req.query.message || "";
    const message_success = req.query.message_success || "";
    
    try {
        const posts_from_db = await getPosts(topic_id, order);
        const posts_to_render = posts_from_db.map(post => {
            const decryptedTitle = decrypt(post.title);
            const decryptedTags = decrypt(post.tags);
            const decryptedContent = decrypt(post.content);
            const encryptedUsername = getUsernameById(post.user_id);
            const decryptedUsername = decrypt(encryptedUsername);
            return {
                id: post.id,
                title: decryptedTitle,
                username: decryptedUsername,
                time_created: post.time_created,
                aura: post.aura
            };
        });
        res.render("forum.ejs", { posts: posts_to_render, message, message_success });
    } catch (error) {
        console.error("Error retrieving posts:", error);
        res.redirect("/forum?message=Error retrieving posts");
    }
});

app.post("/executeCreatePost", (req, res) => {
    if (!req.session.username) {
        res.redirect("/login");
        return;
    }
    
    const { title = "", content = "", topic = "", tags = "" } = req.body;

    if (!title || !content || !topic || !tags) {
        res.redirect("/forum?message=an+error+occured.");
        return;
    }
    
    try {
        createPost(title, topic, req.session.user_id, content, tags);
        res.redirect("/forum?message_success=created+successfully");
    } catch (error) {
        console.error("Error creating post:", error);
        res.redirect("/forum?message=an+error+occured");
    }
});

app.get("/join_private_room", (req, res) => {
    if (req.session.username) {
        res.render("join_private_room.ejs");
    } else {
        res.redirect("/login");
    }
});

// Chat room selection
app.get("/chat_main", async (req, res) => {
    if (!req.session.username) {
        res.redirect("/login");
        return;
    }

    try {
        const rooms = await getRooms();
        const roomsToRender = rooms
            .filter(room => room.password === "")
            .map(room => ({ title: decrypt(room.title), id: room.id }));
        
        res.render("chat_main.ejs", { rooms: roomsToRender, message: req.query.message || "" });
    } catch (error) {
        console.error("Error retrieving chat rooms:", error);
        res.redirect("/chat_main?message=Error retrieving chat rooms");
    }
});

app.get("/room_help", (req, res) => {
    res.render("room_help.ejs");
});

// Chat room access handling
app.get("/chatroom", async (req, res) => {
    if (!req.session.username) {
        res.redirect("/login");
        return;
    }
    
    const room_id = req.query.room_id || await getRoomData(req.query.room_title)?.id;
    
    if (!room_id) {
        return res.redirect("/chat_main");
    }

    try {
        const roomData = getRoomData(room_id);
        const room_title = decrypt(roomData.title);

        if (roomData.password) {
            if (req.session.authedRooms.includes(room_title)) {
                const public_key = decrypt(getPublicKey(req.session.user_id));
                res.render("chatroom.ejs", { room_id, room_title, sender_public_key: public_key, sender_id: req.session.user_id });
            } else {
                res.redirect(`/roomLogin?room_id=${room_id}&room_title=${room_title}`);
            }
        } else {
            res.render("chatroom.ejs", { room_id, room_title, sender_id: req.session.id, sender_public_key: decrypt(getPublicKey(req.session.user_id)) });
        }
    } catch (error) {
        console.error("Error accessing chat room:", error);
        res.redirect("/chat_main?message=Error accessing chat room");
    }
});

app.get("/profile", (req, res) => {
    if (req.session.username) {
        const userData = getUser(req.query.user_id) ? getUser(req.query.user_id) : res.redirect("/");

        const username = decrypt(userData.username);
        const aura = userData.aura;
        const created_at = userData.created_at;
        const admin = userData.admin;
        const public_key = decrypt(userData.public_key);
        const about = isItReal(userData.about) ? decrypt(userData.about) : "";
        const global = userData.global; // Will he show up on global discovery list
        const pfp = userData.pfp;
        const tags = isItReal(userData.tags) ? decrypt(userData.tags) : "";
        const email =  isItReal(userData.email) ? decrypt(userData.email) : "";

        res.render("profile", {username, aura, created_at, admin, public_key, about, global, pfp, tags, email})
    }
});

app.get("/account", (req, res) => {
    if (req.session.username) {
        const userData = getUser(req.session.user_id);

        const username = decrypt(userData.username);
        const aura = userData.aura;
        const created_at = userData.created_at;
        const last_paid = userData.last_paid;
        const admin = userData.admin;
        const public_key = decrypt(userData.public_key);
        const about = isItReal(userData.about) ? decrypt(userData.about) : "";
        const global = userData.global; // Will he show up on global discovery list
        const pfp = userData.pfp;
        const tags = isItReal(userData.tags) ? decrypt(userData.tags) : "";
        const email =  isItReal(userData.email) ? decrypt(userData.email) : "";

        console.log(username, aura, admin, about, global, "pfp", tags, email)

        res.render("account", {username, aura, created_at, admin, last_paid, public_key, about, global, pfp, tags, email})
    }
})



app.post('/updateAccount', upload.single('pfp'), (req, res) => {
    const { username, email, tags, about, global, user_id, public_key, pfp } = req.body;
    if (username == "" || global == "" || public_key == "" || pfp == "") {
        res.redirect("/account");
    }
    const encryptedEmail = encrypt(email);
    const encryptedTags = encrypt(tags);
    const encryptedAbout = encrypt(about);
    const encryptedPublicKey = encrypt(public_key);
    const encryptedUsername = encrypt(username);
    console.log(req.file);
    let newpfp;
    if (req.file) {
        // Convert uploaded file buffer to Base64
        newpfp = req.file.buffer.toString('base64');
    } else {
        newpfp = req.session.pfp;
    }

    //console.log(encryptedEmail, encryptedTags, encryptedAbout, encryptedUsername, newpfp)
    console.log(global, encryptedPublicKey)

    const stmt = db.prepare(`UPDATE users SET username = ?, email = ?, tags = ?, about = ?, global = ?, public_key = ?, pfp = ? WHERE id = ?`);
    stmt.run(encryptedUsername, encryptedEmail, encryptedTags, encryptedAbout, global, encryptedPublicKey, newpfp, req.session.user_id)
        res.redirect("/account"); 
});


// Password check for private chat rooms
app.get("/roomLogin", (req, res) => {
    if (req.session.username) {
        const room_id = req.query.room_id || res.redirect("/chat_main");
        const room_title = req.query.room_title || res.redirect("/chat_main");

        const authToken = crypto.randomBytes(32).toString('hex');
        req.session.authToken = authToken;
        validAuthTokens.push(authToken);

        res.render("chatroom_password.ejs", { room_id, room_title });
    } else {
        res.redirect("/login");
    }
});

// Execute room login with password
app.post("/executeRoomLogin", async (req, res) => {
    if (!req.session.username) {
        return res.redirect("/login");
    }

    if (!req.session.authToken || !validAuthTokens.includes(req.session.authToken)) {
        return res.redirect("/login");
    }

    req.session.authToken = null;

    const room_title = req.body.room_title || res.redirect("/chat_main");
    const room_id = req.body.room_id || res.redirect("/chat_main");
    const request_password = req.body.password;

    if (!request_password) {
        return res.redirect(`/middlemanRoom?destination=${encodeURIComponent("/roomLogin")}`);
    }

    try {
        const roomData = getRoomData(room_id);
        const hashedRequestPassword = await hashPassword(request_password);

        if (decrypt(roomData.password) === hashedRequestPassword) {
            req.session.authedRooms.push(room_title);
            res.redirect(`/middlemanRoom?destination=${encodeURIComponent(`/chatroom?room_id=${room_id}`)}`);
        } else {
            res.redirect(req.get('Referer'));
        }
    } catch (error) {
        console.error("Error executing room login:", error);
        res.redirect("/chat_main?message=Error logging in to room");
    }
});

app.get("/middlemanRoom", (req, res) => {
    res.redirect(req.query.destination || "/login");
});

app.get("/directMessagesMain", (req, res) => {
    if (req.session.username) {
        res.render("direct_messages_main", { user_id: req.session.user_id });
    } else {
        res.redirect("/login");
    }
});

app.get("/goToDirectMessages", (req, res) => {
    if (!req.session.username) {
        return res.redirect("/login");
    }

    const receiver_user_id = req.query.username ? usernameToId[req.query.username] : req.query.user_id || res.redirect("/directMessagesMain");
    
    if (!receiver_user_id) {
        return res.redirect("/directMessagesMain");
    }
    
    res.redirect("/directMessagesChat?user_id=" + receiver_user_id);
});

app.get("/post", async (req, res) => {
    if (!req.session.username) {
        return res.redirect("/login");
    }

    const id = req.query.id || "";
    const comments_sort = req.query.comments_sort || "aura_desc";

    if (id === "") {
        return res.redirect("/forum?message=please+select+a+post+to+view");
    }

    try {
        const post = getPostById(id);
        const decryptedContent = decrypt(post.content);
        const decryptedUsername = decrypt(getUsernameById(post.user_id));
        const decryptedTitle = decrypt(post.title);
        
        const post_to_render = {
            id: post.id,
            content: decryptedContent,
            username: decryptedUsername,
            title: decryptedTitle,
            aura: post.aura,
            created_time: post.created_time
        };
        const poster_data = getUser(post.user_id);
        const poster_pfp = poster_data.pfp;
        const comments_for_post = await getComments(id, comments_sort);
        const comments_to_render = await Promise.all(comments_for_post.map(async comment => {
            const decryptedContentComment = decrypt(comment.content);
            const user = await getUser(comment.user_id); // Get user data using user_id
            const decryptedUsernameComment = decrypt(user.username); // Assuming username is part of user data
            const pfp = user.pfp; // Assuming pfp is part of the user data
        
            return {
                id: comment.id,
                content: decryptedContentComment,
                username: decryptedUsernameComment,
                pfp: pfp, // Add pfp to the comment object
                aura: comment.aura,
                created_time: comment.created_at
            };
        }));

        res.render("post.ejs", { post: post_to_render, comments: comments_to_render, pfp: poster_pfp});
    } catch (error) {
        console.error("Error retrieving post:", error);
        res.redirect("/forum?message=Error retrieving post");
    }
});

app.get("/chathelp", (req, res) => {
    res.render("chat_help.ejs");
});

app.post("/postComment", (req, res) => {
    if (!req.session.username) {
        return res.redirect("/login");
    }

    const { content = "", post_id = "" } = req.body;

    if (!content || !post_id) {
        return res.redirect(`/post?id=${post_id}&message=Error posting comment`);
    }

    try {
        createComment(post_id, req.session.user_id, content);
        res.redirect("/post?id=" + post_id);
    } catch (error) {
        console.error("Error posting comment:", error);
        res.redirect(`/post?id=${post_id}&message=Error posting comment`);
    }
});

app.get("/security", (req, res) => {
    res.render("security.ejs");
});

app.get("/directMessagesChat", (req, res) => {
    if (!req.session.username) {
        return res.redirect("/login");
    }

    const receiver_id = req.query.user_id;

    if (!receiver_id) {
        return res.redirect("/directMessagesMain");
    }

    const sender_id = req.session.user_id;
    const sender_username = getUsernameById(sender_id);
    const receiver_public_key = getPublicKey(receiver_id);
    const sender_public_key = getPublicKey(sender_id);

    const decrypted_receiver_public_key = receiver_public_key !== -1 ? decrypt(receiver_public_key) : "This user does not exist, or does not have a public key associated with their account. Try again.";
    const decrypted_sender_public_key = sender_public_key !== -1 ? decrypt(sender_public_key) : "You don't exist or don't have a public key associated with your account. Try again.";

    const data = {
        receiver_id,
        sender_id,
        sender_username,
        receiver_public_key: decrypted_receiver_public_key,
        sender_public_key: decrypted_sender_public_key
    };
    
    res.render("direct_messages_chat", data);
});

app.get("/createRoom", (req, res) => {
    if (req.session.username) {
        res.render("create_room.ejs");
    } else {
        res.redirect("/login");
    }
});

app.post("/executeCreateRoom", async (req, res) => {
    if (!req.session.username) {
        return res.redirect("/login");
    }

    const room_title = req.body.room_title || res.redirect("/createRoom");
    const password = req.body.password || "";
    const locked = req.body.locked ? 1 : 0;

    try {
        const id = await createRoom(room_title, password, locked);
        res.redirect("/chat_main?message=success: your room id is " + id);
    } catch (error) {
        console.error("Error creating room:", error);
        res.redirect("/createRoom?message=Error creating room");
    }
});

app.post("/executeLogin", async (req, res) => {
    const { username: request_username = "", password: request_password = "" } = req.body;

    if (!request_username || !request_password) {
        return res.redirect("/login?message=Please+provide+username+and+password");
    }

    try {
        const users_database = await getUsers();
        for (const user_database of users_database) {
            const result = await bcrypt.compare(request_password, decrypt(user_database.password));
            if (decrypt(user_database.username) === request_username && result) {
                req.session.username = request_username;
                req.session.admin = user_database.admin;
                req.session.last_paid = user_database.last_paid;
                req.session.user_id = user_database.id;
                req.session.authedRooms = [];
                req.session.pfp = user_database.pfp;
                if (req.session.admin) {
                    logger.info(`An admin logged in - ${req.session.username}`);
                }
                return res.redirect(req.get("Referrer") || "/");
            }
        }
        res.redirect("/login?message=incorrect");
    } catch (error) {
        console.error("Error during login:", error);
        res.redirect("/login?message=Error during login");
    }
});

app.get("/logout", (req, res) => {
    req.session.destroy();
    res.redirect("/login");
});

// Admin routes

app.get("/deleteRoom", (req, res) => {
    if (req.session.admin) {
        res.render("delete_room");
    } else {
        res.redirect("/");
    }
});

app.post("/executeDeleteRoom", (req, res) => {
    if (!req.session.admin) {
        return res.redirect("/");
    }

    const room_title = req.body.room_title || "";
    const room_id = room_title ? roomNameToId[room_title] : req.body.room_id || res.redirect("/chat_main");

    if (!room_id) {
        return res.redirect("/chat_main?message=Invalid room ID");
    }

    try {
        deleteRoom(room_id);
        res.redirect("/chat_main?message=Deleted successfully");
    } catch (error) {
        console.error("Error deleting room:", error);
        res.redirect("/chat_main?message=Error deleting room");
    }
});










io.on('connection', (socket) => {
    console.log('New client connected');
    const session = socket.handshake.session; // Access session data

    socket.on('establishment', async (data) => {
        try {
            console.log(data);
            const sender_id = data.sender_id;
            if (session.username && (session.user_id == sender_id)) {
                console.log("Establishment successful");
                const receiver_id = data.receiver_id;
                const receiver_username = decrypt(getUsernameById(receiver_id));

                const users = receiver_id > sender_id ? `${receiver_id},${sender_id}` : `${sender_id},${receiver_id}`;
                console.log("users: " + users);

                const messages = await getMessages(users);
                const renderMessages = messages.map((message) => ({
                    sender_content: decrypt(message.sender_content),
                    receiver_content: decrypt(message.receiver_content),
                    sender_id: message.user_id_from,
                    receiver_id: message.user_id_to,
                    signature: decrypt(message.signature),
                }));

                console.log(JSON.stringify(renderMessages));
                socket.join(users);
                session.room = users;
                socket.emit("establishment", { receiver_username, messages: renderMessages });
            } else {
                socket.emit("message", { message: "Authentication failed. Please re-login." });
            }
        } catch (error) {
            console.log("Error in establishment event:", error);
        }
    });

    socket.on('sendMessage', (data = { sender_id: "" }) => {
        try {
            console.log("Received sendMessage");
            if (session.username && session.user_id == data.sender_id) {
                const { sender_content, receiver_content, receiver_id, sender_id, signature, save } = data;

                const users = receiver_id > sender_id ? `${receiver_id},${sender_id}` : `${sender_id},${receiver_id}`;
                
                if (save) {
                    createMessage(sender_id, receiver_id, encrypt(sender_content), encrypt(receiver_content), encrypt(signature));
                }

                io.to(users).emit("newMessage", { receiver_content, signature, sender_id, save });
            }
        } catch (error) {
            console.log("Error in sendMessage event:", error);
        }
    });

    socket.on("requestKey", async (data) => {
        try {
            if (session.username && session.authedRooms.includes(data.room_id) && data.sender_id == session.user_id) {
                const roomData = await getRoomData(data.room_id);
                if (roomData.locked) return;

                const public_key = getPublicKey(session.user_id);
                const requestToken = crypto.randomBytes(32).toString('hex');
                requestTokens[requestToken] = session.user_id;

                socket.join(`${session.user_id}:${data.room_id}`);
                io.to(roomData.title).emit("requestKeyForward", { public_key, requestToken });
            }
        } catch (error) {
            console.log("Error in requestKey event:", error);
        }
    });

    socket.on("requestKeyResponse", (data) => {
        try {
            const requestToken = data.requestToken;
            const requester_id = requestTokens[requestToken];
            delete requestTokens[requestToken];

            io.to(`${requester_id}:${data.room_id}`).emit("requestKeyResponseForward", { encryptedKey: data.encryptedKey });
            socket.leave(`${requester_id}:${data.room_id}`);
        } catch (error) {
            console.log("Error in requestKeyResponse event:", error);
        }
    });

    socket.on("establishmentRoom", (data) => {
        try {
            if (session.username && session.user_id == data.sender_id) {
                const { room_title, room_id } = data;

                if (decrypt(getRoomTitleById(room_id)) !== room_title) return;

                const roomData = getRoomData(room_id);
                if (roomData.password && !session.authedRooms.includes(room_title)) return;

                socket.join(room_title);
                session.room = room_title;

                const messages = getMessagesRoom(roomData.id);
                const renderMessages = messages.map((message) => ({
                    content: decrypt(message.content),
                    sender_id: message.user_id,
                    sender_username: getUsernameById(message.user_id),
                    save: message.save,
                }));

                socket.emit("establishmentRoom", { messages: renderMessages });
            }
        } catch (error) {
            console.log("Error in establishmentRoom event:", error);
        }
    });

    socket.on("newMessageRoom", (data) => {
        try {
            if (session.username && session.user_id == data.sender_id) {
                const { content, room_id, room_title } = data;

                if (decrypt(getRoomTitleById(room_id)) !== room_title || !session.authedRooms.includes(room_title)) return;
                if (room_title !== session.room) return;

                if (data.save) {
                    createMessageRoom(room_id, encrypt(content), session.user_id);
                }

                io.to(room_title).emit("newMessage", { content, sender_id: data.sender_id, sender_username: getUsernameById(session.user_id) });
            }
        } catch (error) {
            console.log("Error in newMessageRoom event:", error);
        }
    });

    socket.on('message', (msg) => {
        try {
            console.log(`Received message: ${msg}`);
            io.emit('message', msg);
        } catch (error) {
            console.log("Error in message event:", error);
        }
    });

    socket.on('disconnect', () => {
        try {
            console.log('Client disconnected');
        } catch (error) {
            console.log("Error during disconnect:", error);
        }
    });
});


/*
user1 : user1 : 9
-----BEGIN PUBLIC KEY----- MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCCxG0Kf9AVidPefaWxmJ6eI6lu gKmTQta9APEMROcxD4FpOJQpe0jdY5PMu72fu59h69afiGhRceUWAGRQBatETEi8 Aa2HXbxfU4z/4ZfXIS2tiZvIQM/PkUug6Xp1JDMZSFZhkZsRr8cxPiql6z/3Zku1 qQVISr0N8rar9sjDBQIDAQAB -----END PUBLIC KEY-----

-----BEGIN RSA PRIVATE KEY----- MIICXQIBAAKBgQCCxG0Kf9AVidPefaWxmJ6eI6lugKmTQta9APEMROcxD4FpOJQp e0jdY5PMu72fu59h69afiGhRceUWAGRQBatETEi8Aa2HXbxfU4z/4ZfXIS2tiZvI QM/PkUug6Xp1JDMZSFZhkZsRr8cxPiql6z/3Zku1qQVISr0N8rar9sjDBQIDAQAB AoGAW9CM+yU4tha64un3r9WH8WL6sLK33cS9P6Fsnf+3EBRh+b4XEXUVeRRUjxh2 kLPMuZU8cXD2RdEhVyxZQnJoiBU8SIi4EzZGK2yfgXh0+e4Fq9vCguXI0++qOrgT X+r40N6mjVecR8oQaHtOA5J/phbwyuy8JQlKqhJR/pFk0sECQQDzmTEV0rdwQD7P dXhoVThbDTa12B8cmYGtUtiI8+8mJ69EXqqEx8erIIEl9+pM2Ai7Xf3HHM3dgjzm kyS/Xok1AkEAiWy19bRCGnwwnLAnsyw7HeAB2rBNTgGFLrQ+ucMPD8KLqQ3AcLIz i7DFcs57Ja85WmS29Lv6U68sU4W+wPZckQJBALx2BXq7xn3Kxo1cdaZKYEpZQ72W EiPfQ2tjz/DMwHXFeByuHMCTi4+Cm0hTsGp5LPBAvIkiaMb57sH4jxKbQg0CQD5Y V2SU1rh1RwiO0jPzCQ7QpYa1HR0ai3VYyGw2FgssU3fqiTeXYNMq6yjei/fYushL kMUO0s5MVmu97YBVREECQQCZVfz3kCF3Ue7k4iHZI5BE36DrfDSwlkmjcqX/Nf8z 2zuGjP1biWDBiLKuTfkuul9FXBaNSAaN8tKNfYHCdllY -----END RSA PRIVATE KEY-----

user2: user2 : 10

-----BEGIN PUBLIC KEY----- MIGeMA0GCSqGSIb3DQEBAQUAA4GMADCBiAKBgHfLPLVvTlEe0BAq928wWFQELcvr VS6f+NVv8owaPMVJ6/pgE/WY1ulAJ1/0P1rGJrQVi5t7LaZuI3fD3U8QI4OSsXpA s2t/WC7Uj3Qr2aE1uiA/F7FsSNz7CJRUeO9gM/ws/3Uz/2IBc3frg1muFj4kKNQ4 pSvG9llBNnASi73bAgMBAAE= -----END PUBLIC KEY-----

-----BEGIN RSA PRIVATE KEY----- MIICWQIBAAKBgHfLPLVvTlEe0BAq928wWFQELcvrVS6f+NVv8owaPMVJ6/pgE/WY 1ulAJ1/0P1rGJrQVi5t7LaZuI3fD3U8QI4OSsXpAs2t/WC7Uj3Qr2aE1uiA/F7Fs SNz7CJRUeO9gM/ws/3Uz/2IBc3frg1muFj4kKNQ4pSvG9llBNnASi73bAgMBAAEC fz+juJyqhPCTbfUo3kozZLk9fxbV7mrWkVrSHghP5/jnTHW2lOPkTkebzU8scnvG yMjiqUfwKFBCMpVteCSIblS8HNGufPCuHeYmYOBHmzXrKBQmSFOxLjLeUmc+e60p 7QWV6yIKZRxwu16/mC7/p4HqrNeFAzmtD+aKKp1654ECQQDGJaSL9fr0aMOkhw2H 667ZsS6pgNaxfqXdKbjDP4WEIM+stKBVrhElXN4UAdycjY0L3AVJ+EzbUBEoTpP0 8BIzAkEAmsUlJvxE7pe9glWHSKskMe6YiZ18qOTGFVx2vLtyDcPEAkl6l61D/kQi WXRwqG1i1/TKzREdn9B9jXxGMVYNuQJAA8eABfNhH/xHjwHMbkU+hoRsoWsFrUj/ HOLI1WCGyWhezap8TGYPiajly3fln07L2+gMacbEoII8cYpeJBPYJQJBAIV5NbQs ZSo6tJWdOyFhbsKdGPG9Xs+tFGNBrajQIulaBkVOpyn9pCC5E8J/19R5GYBSvT8i 3qB/xndpUIOlygkCQEa1Y1cmFK+emVNmaWvly+lufi8hcRSwZT+EXU4HYQ8erq6Y uy6/J7A3ETWB49Qe7C8xL9eTbbFzRTPSp1ijaI4= -----END RSA PRIVATE KEY-----

admin : admin : 12
-----BEGIN PUBLIC KEY----- MIGeMA0GCSqGSIb3DQEBAQUAA4GMADCBiAKBgHBP3NRbSxkemKcre2ZJvGWTpb8b Mkv3LEr3wOet9YLMaCsMPxlL+WTHeKblDAk4QorB6TYMY4JXgyJhOnnv4tfgevJM WWTQfUnE+2qUp/EfQgX4hMq5rYrvmLfUwJ96RrYs3mFraszAY8GahjhXXQFYDbVz 5AZcXM9wiQVycisxAgMBAAE= -----END PUBLIC KEY-----


-----BEGIN RSA PRIVATE KEY----- MIICWwIBAAKBgHBP3NRbSxkemKcre2ZJvGWTpb8bMkv3LEr3wOet9YLMaCsMPxlL +WTHeKblDAk4QorB6TYMY4JXgyJhOnnv4tfgevJMWWTQfUnE+2qUp/EfQgX4hMq5 rYrvmLfUwJ96RrYs3mFraszAY8GahjhXXQFYDbVz5AZcXM9wiQVycisxAgMBAAEC gYA9PyAC4iIq+advimPJ3S4TCphZhiBAkvMhksgsz43SHVw1FYGXbvn6vliKUt/k azzGZIakBc+CNez6I6F6+5ltPTVmqzyiHPx3HqRJODSG6LQjFG9nECDXM8eEDl27 QmcxPpUCvc8znCcFU0MVRiTJWSZF4aKa+8aPDSqkqgUwUQJBAKwKh80kCE62DjDd 420iXzwwq6TRbtFFrAX+4kkJ+5fQkKAzUKSLaQ51pw+mnfVaT54JMD0i5AwspLUr B1qdJ90CQQCnHzz09aTBkXOr7fdhpP5Kc5/KQLB/4/YAcE+pg2JVqy1dsO/ZgQyV Lib2Duzp752T07fkoGxTg9x0xThqwKVlAkBLkkSdBBryGF6bcJyaL+MNmYOMXsMD AkvSRmg4FT6DLYaaGHBwFx0K0PuVkGcKg6U9kmOyN0VdY67mNgSA9U+xAkBwGjMw eeoXcfLufES5ugxdcqvX5oa+cvKcHrpBEgGPR7C5rStmcfs3wmqeGSrwTSwdciJj ePzRFJ13sqeCbFFFAkEAnZ4guN3GpjJdmClu8cEwS2zatMZg5NXS9aMYARk+tm1Z rFAjrRetdma0hh68hB+UrY2XKsjp01+QC+qBSZoCzA== -----END RSA PRIVATE KEY-----

*/

server.listen(PORT, async () => {
    updateUsernameToId()
    updateRoomToId();
    // fs.readFile("public/images/logo.png", (err, data) => {
    //     if (err) {
    //         console.error('Error reading the file:', err);
    //         return;
    //     }
    
    //     // Convert to Base64
    //     const base64String = data.toString('base64');
    //     setPfp(1, base64String)
    //     console.log(base64String); // Logs the Base64 string
    // });
    
    //setUserProfilePicture(12, "public/images/logo.png")
    //addPublicKey(11, "-----BEGIN PUBLIC KEY----- MIGeMA0GCSqGSIb3DQEBAQUAA4GMADCBiAKBgHBP3NRbSxkemKcre2ZJvGWTpb8b Mkv3LEr3wOet9YLMaCsMPxlL+WTHeKblDAk4QorB6TYMY4JXgyJhOnnv4tfgevJM WWTQfUnE+2qUp/EfQgX4hMq5rYrvmLfUwJ96RrYs3mFraszAY8GahjhXXQFYDbVz 5AZcXM9wiQVycisxAgMBAAE= -----END PUBLIC KEY-----")

    //console.log(encrypt("signage"))
    //createRoom("private room", "password");
    //createRoom("private room", "password");
    //getAllDecryptedLogs()
    //createUser('admin', 'admin', 1, "I'm an admin.", "-----BEGIN PUBLIC KEY----- MIGeMA0GCSqGSIb3DQEBAQUAA4GMADCBiAKBgHBP3NRbSxkemKcre2ZJvGWTpb8b Mkv3LEr3wOet9YLMaCsMPxlL+WTHeKblDAk4QorB6TYMY4JXgyJhOnnv4tfgevJM WWTQfUnE+2qUp/EfQgX4hMq5rYrvmLfUwJ96RrYs3mFraszAY8GahjhXXQFYDbVz 5AZcXM9wiQVycisxAgMBAAE= -----END PUBLIC KEY-----", 1, "", "admin, tag1", "admin@admin.com");
    
    //createTopic("General");
    //createPost("Test Post!: 2", 1, 3, "This is the content of the second post.", "general, discussion");
    //createComment(1, 3, "Test Comment!");
    //createComment(1, 3, "Test Comment: 2!");
    // const hash = await bcrypt.hash("message", 10)
    // console.log(hash);
    // const result = await bcrypt.compare("user2", "$2b$10$wOKHR84iKgwf49OAVx0WueWb.EmvCzZtoEm2s8Wu9A.nQhfoXn82e")
    // console.log(result)
    // console.log(decrypt("c87c7de12925ae75891569dc8d5d516b69ba99cd2f74781943b98cf60ee318a733dde41e6661708422d7ba42b274e0bf7c4891709b5b0a9fc3db0b75383df8d963bc051b9e2eab24ceafa3c1fb0ae44a"))
    
    console.log("Listening on port " + PORT);
});


















/*
TODO:


Account managament

add "show on global list" column to accounts
add "about" column to accounts
add "pfp" column to accounts
add "tags" column to accounts
account settings page : change username, password (email system??), public key, global list visibility settings, email visibility settings, about, pfp, tags. 

account viewing page: see username, ?email, public key, about, pfp
option to message them


global list: list users who have global list discoverability enabled. Discover new people
search by tags, username. public key

? option to add private key to local storage






*/