// server.js
const express = require('express');
const router = express.Router();
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken'); // Import JWT
const app = express();
const cron = require('node-cron');
const multer = require("multer");

const port = 5000;
const SECRET_KEY = 'your-secret-key'; // Replace with a secure key
const db = new sqlite3.Database('bm.db'); 

app.use(cors());
app.use(bodyParser.json());

// Multer setup for image uploads
const storage = multer.memoryStorage(); // Store image in memory
const upload = multer({
  storage: storage
});



// Create Tthe database tables
db.serialize(() => {
    // Create Admin Table
    db.run(`
      CREATE TABLE IF NOT EXISTS admin (
        admin_id INTEGER PRIMARY KEY AUTOINCREMENT, 
        firstName TEXT NOT NULL,
        lastName TEXT NOT NULL, 
        username TEXT NOT NULL UNIQUE, 
        password TEXT NOT NULL
      );
    `);
  
    // Create Borrowers Table
    db.run(`
      CREATE TABLE IF NOT EXISTS borrowers (
        borrower_id VARCHAR(20) PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        department TEXT,
        email VARCHAR(100) NOT NULL,
        contact_number VARCHAR(100) NOT NULL,
        borrower_type TEXT NOT NULL 
        CHECK (borrower_type IN ('student', 'faculty', 'employee'))
      );
    `);
  
    // Create Book Requests Table
    db.run(`
      CREATE TABLE IF NOT EXISTS book_req(
        req_id INTEGER PRIMARY KEY AUTOINCREMENT,
        borrower_id VARCHAR(20) NOT NULL,
        status TEXT DEFAULT 'Pending',
        req_created DATE DEFAULT CURRENT_DATE,
        req_approve DATE DEFAULT NULL,
        overdue_days INTEGER DEFAULT 0,
        FOREIGN KEY (borrower_id) REFERENCES borrowers(borrower_id) ON DELETE CASCADE
      );
    `);
  
    // Create Borrowed Books Table
    db.run(`
      CREATE TABLE IF NOT EXISTS borrowed_books (
        borrow_id INTEGER PRIMARY KEY AUTOINCREMENT,
        req_id INTEGER NOT NULL,
        book_id INTEGER NOT NULL,
        due_date DATE,
        hours_due INT DEFAULT 0,
        penalty INT DEFAULT 0,
        book_status TEXT DEFAULT 'PENDING',
        FOREIGN KEY (req_id) REFERENCES book_req(req_id) ON DELETE CASCADE,
        FOREIGN KEY (book_id) REFERENCES available_books(book_id)
      );
    `);
  
    db.run(`
      CREATE TABLE IF NOT EXISTS available_books (
        book_id INTEGER PRIMARY KEY AUTOINCREMENT,
        title VARCHAR(255) NOT NULL,
        isbn VARCHAR(20) NOT NULL UNIQUE,
        author VARCHAR(100) NOT NULL,
        description TEXT(500),
        total_copies INTEGER NOT NULL,
        available_copies INTEGER NOT NULL,
        cover_image BLOB
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS book_categories (
          book_id INTEGER NOT NULL,
          category_id INTEGER NOT NULL,
          PRIMARY KEY (book_id, category_id),
          FOREIGN KEY (book_id) REFERENCES available_books(book_id) ON DELETE CASCADE,
          FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE CASCADE
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS categories (
          category_id INTEGER PRIMARY KEY AUTOINCREMENT,
          name VARCHAR(100) UNIQUE NOT NULL
      );
    `);
  });

// Generate JWT Token
const generateToken = (user) => {
    return jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: '1h' });
};

// Middleware to verify JWT Token
const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ message: 'Access denied. No token provided.' });

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ message: 'Invalid token.' });
        req.user = user;
        next();
    });
};


// Landing Page APIs

  // Search API: /search?query=bookTitle&page=1&limit=10
  app.get("/search", (req, res) => {
    const { query = "", page = 1, limit = 5 } = req.query;
    const offset = (page - 1) * limit;
  
    const sql = `
      SELECT * FROM available_books
      WHERE title LIKE ? OR author LIKE ? OR isbn LIKE ?
      LIMIT ? OFFSET ?
    `;
    const params = [`%${query}%`, `%${query}%`, `%${query}%`, limit, offset];
  
    db.all(sql, params, (err, rows) => {
      if (err) {
        console.error(err.message);
        return res.status(500).json({ error: "Failed to fetch books" });
      }
  
      // Convert BLOB to Base64 string
      const results = rows.map((book) => ({
        ...book,
        cover_image: book.cover_image
          ? Buffer.from(book.cover_image).toString("base64")
          : null,
      }));
  
      res.json({ results });
    });
  });

  app.get("/all-books", (req, res) => {
    const { category_id, page = 1, limit = 10 } = req.query;
  
    const offset = (page - 1) * limit;
  
    let baseQuery = `
      SELECT available_books.*, GROUP_CONCAT(categories.name) AS categories
      FROM available_books
      LEFT JOIN book_categories ON available_books.book_id = book_categories.book_id
      LEFT JOIN categories ON book_categories.category_id = categories.category_id
    `;
  
    const filters = [];
    const queryParams = [];
  
    if (category_id) {
      filters.push(`book_categories.category_id = ?`);
      queryParams.push(category_id);
    }
  
    if (filters.length > 0) {
      baseQuery += ` WHERE ${filters.join(" AND ")}`;
    }
  
    baseQuery += ` GROUP BY available_books.book_id LIMIT ? OFFSET ?`;
    queryParams.push(parseInt(limit), parseInt(offset));
  
    db.all(baseQuery, queryParams, (err, rows) => {
      if (err) {
        console.error(err.message);
        return res.status(500).json({ error: "Failed to fetch books" });
      }
  
      // Map rows to include Base64 encoding for the cover image
      const booksWithImages = rows.map((row) => {
        return {
          ...row,
          cover_image: row.cover_image
            ? row.cover_image.toString("base64")
            : null, // Encode the BLOB as Base64 or return null if no image
        };
      });
  
      res.json({ books: booksWithImages });
    });
  });

// API to fetch top 5 most borrowed books
app.get('/api/top-borrowed-books', (req, res) => {
  const query = `
    SELECT ab.book_id, ab.title, ab.cover_image, COUNT(bb.book_id) AS borrow_count
    FROM borrowed_books bb
    JOIN available_books ab ON bb.book_id = ab.book_id
    GROUP BY bb.book_id
    ORDER BY borrow_count DESC
    LIMIT 5;
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Error fetching top borrowed books:', err.message);
      return res.status(500).json({ message: 'Error fetching top borrowed books' });
    }

    // Convert cover_image BLOB to Base64 for display
    const booksWithBase64Images = rows.map(book => {
      const base64Image = book.cover_image.toString('base64');
      return { ...book, cover_image: base64Image };
    });

    res.json(booksWithBase64Images);
  });
});


  
    // Get book details by ID
  app.get('/books/:id', (req, res) => {
    const bookId = parseInt(req.params.id, 10); // Convert and validate the bookId
  
    // Validate bookId
    if (isNaN(bookId) || bookId < 1) {
      return res.status(400).json({ error: 'Invalid book ID' });
    }
  
    // Fetch the book details from the database
    db.get('SELECT * FROM available_books WHERE book_id = ?', [bookId], (err, row) => {
      if (err) {
        console.error('Database error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
      }
  
      if (!row) {
        return res.status(404).json({ error: 'Book not found' });
      }
  
      // Convert the cover_image to a Base64 string if it exists
      if (row.cover_image) {
        row.cover_image = row.cover_image.toString('base64');
      }
  
      res.json(row); // Send the book details as JSON
    });
  });
  
  // Register endpoint
app.post('/api/register', (req, res) => {
    const { firstName, lastName, username, password } = req.body;
    db.run(`INSERT INTO admin (firstName, lastName, username, password) VALUES (?, ?, ?, ?)`, [firstName, lastName, username, password], function (err) {
        if (err) {
            return res.status(400).json({ message: 'User already exists' });
            console.log(username, password);
        }
        const token = generateToken({ id: this.lastID, username });
        res.status(201).json({ id: this.lastID, username, token });
    });
});


  // Login endpoint
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    // Check if username exists
    db.get(`SELECT * FROM admin WHERE username = ?`, [username], (err, row) => {
        if (err) {
            return res.status(500).json({ message: 'Internal server error' });
        }
        if (!row) {
            console.log('Username does not exist:', username);
            return res.status(401).json({ message: 'Username does not exist' });
        }

        // Check if the password matches
        if (row.password !== password) {
            return res.status(401).json({ message: 'Incorrect password' });
        }

        // If both username and password are correct, generate token
        const token = generateToken(row); // Generate JWT
        res.json({ id: row.id, username: row.username, token });
    });
});

  //Fetch Available Books
app.get('/available-books', (req, res) => {
  const query = `
    SELECT 
      book_id, title, isbn, author, available_copies 
    FROM 
      available_books 
    WHERE 
      available_copies > 0
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Error fetching available books:', err.message);
      res.status(500).json({ message: 'Failed to retrieve books' });
    } else {
      res.status(200).json(rows);
    }
  });
});


// Request a book
app.post('/borrow-book', (req, res) => {
  const { studentId, firstName, lastName, email, contactNumber, borrowerType, department, books } = req.body;

  // Validate required fields
  if (!studentId || !firstName || !lastName || !email || !contactNumber || !borrowerType || !department || !books.length) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  // Validate borrower type
  const validTypes = ['student', 'faculty', 'employee'];
  if (!validTypes.includes(borrowerType)) {
    return res.status(400).json({ message: 'Invalid borrower type.' });
  }

  // Define book limits per borrower type
  const rules = {
    student: { maxBooks: 3, dueDays: 7 },
    faculty: { maxBooks: 10, dueDays: 120 }, // 1 semester (~120 days)
    employee: { maxBooks: 10, dueDays: 7 },
  };

  const { maxBooks } = rules[borrowerType];

  // Enforce book limit
  if (books.length > maxBooks) {
    return res.status(400).json({ message: `${borrowerType}s can only borrow up to ${maxBooks} books.` });
  }

  // Step 1: Insert or Update Borrower Info in `borrowers` Table
  db.run(
    `INSERT INTO borrowers (borrower_id, first_name, last_name, email, contact_number, borrower_type, department) 
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(borrower_id) DO UPDATE SET 
     first_name = excluded.first_name, 
     last_name = excluded.last_name, 
     email = excluded.email, 
     contact_number = excluded.contact_number,
     borrower_type = excluded.borrower_type,
     department = excluded.department`,
    [studentId, firstName, lastName, email, contactNumber, borrowerType, department],
    function (err) {
      if (err) {
        console.error('Error inserting/updating borrower:', err.message);
        return res.status(500).json({ message: 'Error saving borrower info' });
      }

      // Step 2: Insert Borrow Request in `book_req` Table
      db.run('INSERT INTO book_req (borrower_id) VALUES (?)', [studentId], function (err) {
        if (err) {
          console.error('Error creating borrow request:', err.message);
          return res.status(500).json({ message: 'Error creating borrow request' });
        }

        const borrowRequestId = this.lastID;

        // Step 3: Bulk Insert Books into `borrowed_books` Table
        const insertBooks = books.map((book) => {
          return new Promise((resolve, reject) => {
            db.run(
              'INSERT INTO borrowed_books (req_id, book_id, due_date) VALUES (?, ?, ?)',
              [borrowRequestId, book.value, null],
              function (err) {
                if (err) {
                  console.error('Error inserting borrowed book:', err.message);
                  return reject(err);
                }
                resolve();
              }
            );
          });
        });

        // Wait for all books to be inserted
        Promise.all(insertBooks)
          .then(() => {
            // Return success response with borrow request ID
            res.status(201).json({
              message: 'Borrow request successfully registered.',
              requestId: borrowRequestId, // Include the request ID in the response
            });
          })
          .catch((err) => {
            console.error('Error inserting books:', err.message);
            res.status(500).json({ message: 'Error registering borrowed books.' });
          });
      });
    }
  );
});

// Backend route to get tracking URL
app.get('/generate-qr/:req_id', (req, res) => {
  const { req_id } = req.params;
  const trackingURL = `http://localhost:3000/track-request/${req_id}`;
  res.json({ trackingURL });
});

// Track the status of a borrow request
app.get('/track-request/:req_id', (req, res) => {
  const { req_id } = req.params;

  const query = `
    SELECT 
      br.status AS request_status,
      b.first_name || ' ' || b.last_name AS borrower_name,
      ab.title AS book_title,
      bb.due_date AS due_date,
      bb.hours_due AS hours_due,
      bb.penalty AS penalty,
      bb.book_status AS book_status
    FROM book_req br
    JOIN borrowers b ON br.borrower_id = b.borrower_id
    JOIN borrowed_books bb ON br.req_id = bb.req_id
    JOIN available_books ab ON bb.book_id = ab.book_id
    WHERE br.req_id = ?;
  `;

  db.all(query, [req_id], (err, rows) => {
    if (err) {
      console.error('Error fetching request details:', err.message);
      return res.status(500).json({ message: 'Error fetching request details.' });
    }

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Request not found.' });
    }

    // Group data into a structured format
    const { borrower_name, request_status } = rows[0];
    const books = rows.map(row => ({
      title: row.book_title,
      due_date: row.due_date,
      hours_due: row.hours_due,
      penalty: row.penalty,
      status: row.book_status,
    }));

    res.status(200).json({ borrower_name, request_status, books });
  });
});







// Dashboard Page APIs
  //Overview Page
  app.get('/request-counts', (req, res) => {
    db.all('SELECT status, COUNT(*) AS count FROM book_req GROUP BY status', [], (err, rows) => {
      if (err) {
        console.error('Error fetching request counts:', err.message);
        return res.status(500).json({ message: 'Error fetching request counts' });
      }
  
      const counts = { pending: 0, approved: 0, rejected: 0, overdue: 0 };
  
      rows.forEach(row => {
        if (row.status === 'Pending') counts.pending = row.count;
        if (row.status === 'Approved') counts.approved = row.count;
        if (row.status === 'Rejected') counts.rejected = row.count;
        if (row.status === 'Overdue') counts.overdue = row.count;
      });
  
      res.json(counts);
    });
  });
// Endpoint to get request counts for today and yesterday
app.get('/request-date', (req, res) => {
  const queries = [
    { name: 'todayCount', query: `SELECT COUNT(*) AS count FROM book_req WHERE req_created = CURRENT_DATE` },
    { name: 'yesterdayCount', query: `SELECT COUNT(*) AS count FROM book_req WHERE req_created = DATE('now', '-1 day')` },
    { name: 'totalCount', query: `SELECT COUNT(*) AS count FROM book_req` },
  ];

  Promise.all(
    queries.map(({ query }) => new Promise((resolve, reject) => {
      db.get(query, (err, result) => {
        if (err) return reject(err);
        resolve(result.count || 0);
      });
    }))
  )
  .then(([todayCount, yesterdayCount, totalCount]) => {
    res.json({ todayCount, yesterdayCount, totalCount });
  })
  .catch(error => {
    console.error('Error fetching request counts:', error);
    res.status(500).json({ error: 'Error fetching request counts' });
  });
});

//Chart Data
app.get('/chart-data', (req, res) => {
  const query = `
    SELECT 
      strftime('%m', req_created) AS month,
      SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'Approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'Overdue' THEN 1 ELSE 0 END) AS overdue
    FROM book_req
    GROUP BY month
    ORDER BY month;
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    // Format the data for the chart
    const chartData = {
      months: rows.map(row => row.month),
      pending: rows.map(row => row.pending),
      approved: rows.map(row => row.approved),
      overdue: rows.map(row => row.overdue),
    };

    res.json(chartData);
  });
});

// Show Requests
  // Show all requests
  app.get('/all-req', (req, res) => {
    const sql = `
      SELECT 
        br.req_id,
        br.borrower_id,
        br.status,
        br.req_created,
        br.req_approve,
        b.first_name,
        b.last_name,
        b.borrower_type,
        bb.borrow_id,
        bb.book_id,
        ab.title,
        ab.isbn,
        bb.due_date,
        bb.book_status,
        bb.hours_due,
        bb.penalty
      FROM 
        book_req AS br
      JOIN 
        borrowers AS b ON br.borrower_id = b.borrower_id
      LEFT JOIN 
        borrowed_books AS bb ON br.req_id = bb.req_id
      LEFT JOIN 
        available_books AS ab ON bb.book_id = ab.book_id
      ORDER BY 
        br.req_id;
    `;
  
    db.all(sql, [], (err, rows) => {
      if (err) {
        console.error('Error fetching book requests:', err.message);
        return res.status(500).json({ message: 'Error fetching book requests.' });
      }
  
      // Format the result to group borrowed books under their respective requests
      const formattedResponse = rows.reduce((acc, row) => {
        const {
          req_id,
          borrower_id,
          status,
          req_created,
          req_approve,
          first_name,
          last_name,
          borrower_type,
          borrow_id,
          book_id,
          title,
          isbn,
          due_date,
          book_status,
          hours_due,
          penalty
        } = row;
  
        // Check if the request already exists in the accumulator
        let request = acc.find((r) => r.req_id === req_id);
        if (!request) {
          request = {
            req_id,
            borrower_id,
            status,
            req_created,
            req_approve,
            borrower: {
              first_name,
              last_name,
              borrower_type,
            },
            books: [],
          };
          acc.push(request);
        }
  
        // If there's a book, add it to the request
        if (book_id) {
          request.books.push({
            borrow_id,
            book_id,
            title,
            isbn,
            due_date,
            book_status,
            hours_due,
            penalty
          });
        }
  
        return acc;
      }, []);
  
      res.status(200).json(formattedResponse);
    });
  });

  // Show pending requests
  app.get('/pending-req', (req, res) => {
    const sql = `
      SELECT 
        br.req_id,
        br.borrower_id,
        br.status,
        br.req_created,
        br.req_approve,
        b.first_name,
        b.last_name,
        b.borrower_type,
        bb.borrow_id,
        bb.book_id,
        ab.title,
        ab.isbn,
        bb.due_date,
        bb.book_status,
        bb.hours_due,
        bb.penalty
      FROM 
        book_req AS br
      JOIN 
        borrowers AS b ON br.borrower_id = b.borrower_id
      LEFT JOIN 
        borrowed_books AS bb ON br.req_id = bb.req_id
      LEFT JOIN 
        available_books AS ab ON bb.book_id = ab.book_id
      WHERE 
        br.status = 'Pending'
      ORDER BY 
        br.req_id;
    `;
  
    db.all(sql, [], (err, rows) => {
      if (err) {
        console.error('Error fetching book requests:', err.message);
        return res.status(500).json({ message: 'Error fetching book requests.' });
      }
  
      // Format the result to group borrowed books under their respective requests
      const formattedResponse = rows.reduce((acc, row) => {
        const {
          req_id,
          borrower_id,
          status,
          req_created,
          req_approve,
          first_name,
          last_name,
          borrower_type,
          borrow_id,
          book_id,
          title,
          isbn,
          due_date,
          book_status,
          hours_due,
          penalty
        } = row;
  
        // Check if the request already exists in the accumulator
        let request = acc.find((r) => r.req_id === req_id);
        if (!request) {
          request = {
            req_id,
            borrower_id,
            status,
            req_created,
            req_approve,
            borrower: {
              first_name,
              last_name,
              borrower_type,
            },
            books: [],
          };
          acc.push(request);
        }
  
        // If there's a book, add it to the request
        if (book_id) {
          request.books.push({
            borrow_id,
            book_id,
            title,
            isbn,
            due_date,
            book_status,
            hours_due,
            penalty
          });
        }
  
        return acc;
      }, []);
  
      res.status(200).json(formattedResponse);
    });
});

  // Show approved requests
app.get('/approved-req', (req, res) => {
    const sql = `
      SELECT 
        br.req_id,
        br.borrower_id,
        br.status,
        br.req_created,
        br.req_approve,
        b.first_name,
        b.last_name,
        b.borrower_type,
        bb.borrow_id,
        bb.book_id,
        ab.title,
        ab.isbn,
        bb.due_date,
        bb.book_status,
        bb.hours_due,
        bb.penalty
      FROM 
        book_req AS br
      JOIN 
        borrowers AS b ON br.borrower_id = b.borrower_id
      LEFT JOIN 
        borrowed_books AS bb ON br.req_id = bb.req_id
      LEFT JOIN 
        available_books AS ab ON bb.book_id = ab.book_id
      WHERE 
        br.status = 'Approved'
      ORDER BY 
        br.req_id;
    `;
  
    db.all(sql, [], (err, rows) => {
      if (err) {
        console.error('Error fetching book requests:', err.message);
        return res.status(500).json({ message: 'Error fetching book requests.' });
      }
  
      // Format the result to group borrowed books under their respective requests
      const formattedResponse = rows.reduce((acc, row) => {
        const {
          req_id,
          borrower_id,
          status,
          req_created,
          req_approve,
          first_name,
          last_name,
          borrower_type,
          borrow_id,
          book_id,
          title,
          isbn,
          due_date,
          book_status,
          hours_due,
          penalty
        } = row;
  
        // Check if the request already exists in the accumulator
        let request = acc.find((r) => r.req_id === req_id);
        if (!request) {
          request = {
            req_id,
            borrower_id,
            status,
            req_created,
            req_approve,
            borrower: {
              first_name,
              last_name,
              borrower_type,
            },
            books: [],
          };
          acc.push(request);
        }
  
        // If there's a book, add it to the request
        if (book_id) {
          request.books.push({
            borrow_id,
            book_id,
            title,
            isbn,
            due_date,
            book_status,
            hours_due,
            penalty
          });
        }
  
        return acc;
      }, []);
  
      res.status(200).json(formattedResponse);
    });
});

  // Show rejected requests
app.get('/rejected-req', (req, res) => {
    const sql = `
      SELECT 
        br.req_id,
        br.borrower_id,
        br.status,
        br.req_created,
        br.req_approve,
        b.first_name,
        b.last_name,
        b.borrower_type,
        bb.borrow_id,
        bb.book_id,
        ab.title,
        ab.isbn,
        bb.due_date,
        bb.hours_due,
        bb.penalty
      FROM 
        book_req AS br
      JOIN 
        borrowers AS b ON br.borrower_id = b.borrower_id
      LEFT JOIN 
        borrowed_books AS bb ON br.req_id = bb.req_id
      LEFT JOIN 
        available_books AS ab ON bb.book_id = ab.book_id
      WHERE 
        br.status = 'Rejected'
      ORDER BY 
        br.req_id;
    `;
  
    db.all(sql, [], (err, rows) => {
      if (err) {
        console.error('Error fetching book requests:', err.message);
        return res.status(500).json({ message: 'Error fetching book requests.' });
      }
  
      // Format the result to group borrowed books under their respective requests
      const formattedResponse = rows.reduce((acc, row) => {
        const {
          req_id,
          borrower_id,
          status,
          req_created,
          req_approve,
          first_name,
          last_name,
          borrower_type,
          borrow_id,
          book_id,
          title,
          isbn,
          due_date,
          hours_due,
          penalty
        } = row;
  
        // Check if the request already exists in the accumulator
        let request = acc.find((r) => r.req_id === req_id);
        if (!request) {
          request = {
            req_id,
            borrower_id,
            status,
            req_created,
            req_approve,
            borrower: {
              first_name,
              last_name,
              borrower_type,
            },
            books: [],
          };
          acc.push(request);
        }
  
        // If there's a book, add it to the request
        if (book_id) {
          request.books.push({
            borrow_id,
            book_id,
            title,
            isbn,
            due_date,
            hours_due,
            penalty
          });
        }
  
        return acc;
      }, []);
  
      res.status(200).json(formattedResponse);
    });
});

  // Show overdue requests
app.get('/overdue-req', (req, res) => {
    const sql = `
      SELECT 
        br.req_id,
        br.borrower_id,
        br.status,
        br.req_created,
        br.req_approve,
        b.first_name,
        b.last_name,
        b.borrower_type,
        bb.borrow_id,
        bb.book_id,
        ab.title,
        ab.isbn,
        bb.due_date,
        bb.book_status,
        bb.hours_due,
        bb.penalty
      FROM 
        book_req AS br
      JOIN 
        borrowers AS b ON br.borrower_id = b.borrower_id
      LEFT JOIN 
        borrowed_books AS bb ON br.req_id = bb.req_id
      LEFT JOIN 
        available_books AS ab ON bb.book_id = ab.book_id
      WHERE 
        br.status = 'Overdue'
      ORDER BY 
        br.req_id;
    `;
  
    db.all(sql, [], (err, rows) => {
      if (err) {
        console.error('Error fetching book requests:', err.message);
        return res.status(500).json({ message: 'Error fetching book requests.' });
      }
  
      // Format the result to group borrowed books under their respective requests
      const formattedResponse = rows.reduce((acc, row) => {
        const {
          req_id,
          borrower_id,
          status,
          req_created,
          req_approve,
          first_name,
          last_name,
          borrower_type,
          borrow_id,
          book_id,
          title,
          isbn,
          due_date,
          book_status,
          hours_due,
          penalty
        } = row;
  
        // Check if the request already exists in the accumulator
        let request = acc.find((r) => r.req_id === req_id);
        if (!request) {
          request = {
            req_id,
            borrower_id,
            status,
            req_created,
            req_approve,
            borrower: {
              first_name,
              last_name,
              borrower_type,
            },
            books: [],
          };
          acc.push(request);
        }
  
        // If there's a book, add it to the request
        if (book_id) {
          request.books.push({
            borrow_id,
            book_id,
            title,
            isbn,
            due_date,
            book_status,
            hours_due,
            penalty
          });
        }
  
        return acc;
      }, []);
  
      res.status(200).json(formattedResponse);
    });
});

// Show Borrowers
app.get('/borrowers', (req, res) => {
  db.all(
    `SELECT borrower_id, first_name, last_name, department, email, contact_number, borrower_type FROM borrowers`,
    [], // You can pass parameters to the query if necessary
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message }); // Handle any error that occurs
        return;
      }
      res.json(rows); // Return the rows as the API response
    }
  );
});

app.get('/return-req', (req, res) => {
  const sql = `
    SELECT 
      br.req_id,
      br.borrower_id,
      br.status,
      br.req_created,
      br.req_approve,
      b.first_name,
      b.last_name,
      b.borrower_type,
      bb.borrow_id,
      bb.book_id,
      ab.title,
      ab.isbn,
      bb.due_date,
      bb.book_status,
      bb.hours_due,
      bb.penalty
    FROM 
      book_req AS br
    JOIN 
      borrowers AS b ON br.borrower_id = b.borrower_id
    LEFT JOIN 
      borrowed_books AS bb ON br.req_id = bb.req_id
    LEFT JOIN 
      available_books AS ab ON bb.book_id = ab.book_id
    WHERE 
      br.status = 'Returned'
    ORDER BY 
      br.req_id;
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('Error fetching book requests:', err.message);
      return res.status(500).json({ message: 'Error fetching book requests.' });
    }

    // Format the result to group borrowed books under their respective requests
    const formattedResponse = rows.reduce((acc, row) => {
      const {
        req_id,
        borrower_id,
        status,
        req_created,
        req_approve,
        first_name,
        last_name,
        borrower_type,
        borrow_id,
        book_id,
        title,
        isbn,
        due_date,
        book_status,
        hours_due,
        penalty
      } = row;

      // Check if the request already exists in the accumulator
      let request = acc.find((r) => r.req_id === req_id);
      if (!request) {
        request = {
          req_id,
          borrower_id,
          status,
          req_created,
          req_approve,
          borrower: {
            first_name,
            last_name,
            borrower_type,
          },
          books: [],
        };
        acc.push(request);
      }

      // If there's a book, add it to the request
      if (book_id) {
        request.books.push({
          borrow_id,
          book_id,
          title,
          isbn,
          due_date,
          book_status,
          hours_due,
          penalty
        });
      }

      return acc;
    }, []);

    res.status(200).json(formattedResponse);
  });
});



// Endpoint to get total count of borrowers
app.get("/api/borrowers/count", (req, res) => {
  db.get("SELECT COUNT(*) AS total_borrowers FROM borrowers", [], (err, row) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "An error occurred" });
    }
    res.json({ total_borrowers: row.total_borrowers });
  });
});

// Endpoint to get borrower type distribution
app.get("/api/borrowers/type-distribution", (req, res) => {
  db.all("SELECT borrower_type, COUNT(*) AS count FROM borrowers GROUP BY borrower_type", [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "An error occurred" });
    }
    res.json({ borrower_types: rows });
  });
});



// Buttons 
  // Approve a request
  app.post('/approve-request', (req, res) => {
    const { reqId } = req.body;
  
    // Validate reqId
    if (!reqId) {
      return res.status(400).json({ message: 'Request ID is required.' });
    }
  
    // Query to get the borrower type and associated book IDs based on the request ID
    const getBorrowerDetailsQuery = `
      SELECT borrowers.borrower_type, book_req.borrower_id, bb.book_id
      FROM book_req
      JOIN borrowers ON book_req.borrower_id = borrowers.borrower_id
      JOIN borrowed_books AS bb ON book_req.req_id = bb.req_id
      WHERE book_req.req_id = ?
    `;
  
    // Define due days per borrower type
    const rules = {
      student: 7, // 7 days
      faculty: 120, // 1 semester (~120 days)
      employee: 7, // 7 days
    };
  
    db.all(getBorrowerDetailsQuery, [reqId], (err, rows) => {
      if (err) {
        console.error('Error fetching borrower details:', err.message);
        return res.status(500).json({ message: 'Error fetching borrower details' });
      }
  
      if (rows.length === 0) {
        return res.status(404).json({ message: 'Request or borrower not found.' });
      }
  
      const borrowerType = rows[0].borrower_type;
      const borrowerId = rows[0].borrower_id;
  
      const dueDays = rules[borrowerType];
  
      // Calculate the due date based on the current date
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + dueDays);
      const formattedDueDate = dueDate.toISOString().split('T')[0]; // YYYY-MM-DD
  
      // Step 1: Update the request status and approval date
      db.run(
        'UPDATE book_req SET status = ?, req_approve = CURRENT_DATE WHERE req_id = ?',
        ['Approved', reqId],
        function (err) {
          if (err) {
            console.error('Error updating book request status:', err.message);
            return res.status(500).json({ message: 'Error updating book request status' });
          }
  
          // Step 2: Update the due date and book status for all books associated with the request
          db.run(
            'UPDATE borrowed_books SET due_date = ?, book_status = ? WHERE req_id = ?',
            [formattedDueDate, 'UNRETURNED', reqId],
            function (err) {
              if (err) {
                console.error('Error updating due date and book status:', err.message);
                return res.status(500).json({ message: 'Error updating due date and book status' });
              }
  
              // Step 3: Reduce available copies for the specific book
              const updateAvailableCopiesQuery = `
                UPDATE available_books
                SET available_copies = available_copies - 1
                WHERE book_id = ?
              `;
  
              rows.forEach((row) => {
                db.run(updateAvailableCopiesQuery, [row.book_id], (err) => {
                  if (err) {
                    console.error(`Error reducing available copies for book_id ${row.book_id}:`, err.message);
                  }
                });
              });
  
              // Respond to the client after all operations
              res.status(200).json({ message: 'Request approved, due date updated, and available copies reduced successfully.' });
            }
          );
        }
      );
    });
  });

 // Reject a request
 app.post('/reject-request', (req, res) => {
  const { reqId } = req.body;

  // Validate reqId
  if (!reqId) {
    return res.status(400).json({ message: 'Request ID is required.' });
  }

  // Update the request status to "Rejected"
  db.run(
    'UPDATE book_req SET status = ? WHERE req_id = ?',
    ['Rejected', reqId],
    function (err) {
      if (err) {
        console.error('Error updating book request status:', err.message);
        return res.status(500).json({ message: 'Error updating book request status' });
      }

      // Check if the update affected any rows
      if (this.changes === 0) {
        return res.status(404).json({ message: 'Request not found or already rejected.' });
      }

      // Respond with success
      res.status(200).json({ message: 'Request status updated to Rejected successfully' });
    }
  );
});

 // Return a request
 app.post('/return-request', (req, res) => {
  const { reqId } = req.body;

  // Validate reqId
  if (!reqId) {
    return res.status(400).json({ message: 'Request ID is required.' });
  }

  // Update the request status to "Rejected"
  db.run(
    'UPDATE book_req SET status = ? WHERE req_id = ?',
    ['Returned', reqId],
    function (err) {
      if (err) {
        console.error('Error updating book request status:', err.message);
        return res.status(500).json({ message: 'Error updating book request status' });
      }

      // Check if the update affected any rows
      if (this.changes === 0) {
        return res.status(404).json({ message: 'Request not found or already rejected.' });
      }

      // Respond with success
      res.status(200).json({ message: 'Request status updated to Rejected successfully' });
    }
  );
});

// Delete a Request
app.delete('/delete-request/:reqId', async (req, res) => {
  const { reqId } = req.params;

  try {
    // Check if the request exists
    const requestExists = await db.get(
      'SELECT req_id FROM book_req WHERE req_id = ?',
      [reqId]
    );

    if (!requestExists) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // Delete related borrowed book records if applicable
    await db.run('DELETE FROM borrowed_books WHERE req_id = ?', [reqId]);

    // Delete the request itself
    await db.run('DELETE FROM book_req WHERE req_id = ?', [reqId]);

    res.json({ message: 'Request deleted successfully' });
  } catch (error) {
    console.error('Error deleting request:', error);
    res.status(500).json({ error: 'An error occurred while deleting the request' });
  }
});

//Delete Book
app.delete('/delete-book/:bookId', async (req, res) => {
  const { bookId } = req.params;

  try {
    // Run the delete query
    const result = await db.run('DELETE FROM available_books WHERE book_id = ?', [bookId]);

    // Check if any rows were affected (book exists)
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Book not found' });
    }

    res.json({ message: 'Book deleted successfully' });
  } catch (error) {
    console.error('Error deleting book:', error);
    res.status(500).json({ error: 'An error occurred while deleting the book' });
  }
});


//Renew Book
const rules = {
  student: 7, // 7 days
  faculty: 120, // 1 semester (~120 days)
  employee: 7, // 7 days
};

app.post('/renew-book', async (req, res) => {
  const { book_id, req_id, borrower_type } = req.body;
  console.log(book_id, req_id, borrower_type);

  // Validate input
  if (!book_id || !req_id || !borrower_type) {
    return res.status(400).json({ error: 'book_id, req_id, and borrower_type are required' });
  }

  // Check if the borrower type exists in rules
  const renewalDays = rules[borrower_type];
  if (!renewalDays) {
    return res.status(400).json({ error: `Invalid borrower type: ${borrower_type}` });
  }

  console.log(`Renewal Days: ${renewalDays}`);

  try {
    // Update the due date directly in the database using SQLite's DATE function
    const result = await db.run(
      `UPDATE borrowed_books
       SET due_date = DATE(due_date, ?),
           hours_due = 0,
           penalty = 0
       WHERE book_id = ? AND req_id = ?`,
      [`+${renewalDays} days`, book_id, req_id]
    );
    
    

    console.log(`Rows affected: ${result.changes}`);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'No matching record found to renew' });
    }

    res.json({ message: 'Book renewed successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'An error occurred while renewing the book' });
  }
});



//Remove Book
app.delete('/remove-book', async (req, res) => {
  const { book_id, req_id } = req.body;

  // Validate input
  if (!book_id || !req_id) {
    return res.status(400).json({ error: 'book_id and req_id are required' });
  }

  try {
    // Delete query
    const result = await db.run(
      `DELETE FROM borrowed_books WHERE book_id = ? AND req_id = ?`,
      [book_id, req_id]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'No matching record found to delete' });
    }

    res.json({ message: 'Book removed successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'An error occurred while removing the book' });
  }
});



// Show Total Books (Unique Book Count)
app.get('/api/total-books', (req, res) => {
  db.get(
    `SELECT COUNT(DISTINCT title) AS total_books FROM available_books`, 
    (err, row) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }

      // Log the result to check the value
      console.log('Total Books Row:', row);

      // If row is null or doesn't contain a valid total_books value, log it
      if (!row || row.total_books === null) {
        console.log('No total books found or result is null.');
      }

      res.json({ totalBooks: row?.total_books || 0 }); // Respond with 0 if no value is found
    }
  );
});

 //Show all books
 app.get('/book-list', (req, res) => {
  db.all(
    `SELECT book_id, title, isbn, author, total_copies, available_copies FROM available_books`,
    [],
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json(rows);
    }
  );
});

//Show available book copies
app.get('/api/total-available-books', async (req, res) => {
  try {
    const query = `SELECT SUM(available_copies) AS total_available FROM available_books`;
    db.get(query, (err, row) => {
      if (err) {
        console.error('Database Error:', err.message);
        return res.status(500).json({ error: 'Database query failed' });
      }

      res.json({ totalAvailableBooks: row?.total_available || 0 });
    });
  } catch (error) {
    console.error('Server Error:', error);
    res.status(500).json({ error: 'An error occurred while fetching total available books.' });
  }
});

//Show Total Borrowed Books
app.get('/api/total-borrowed-books', async (req, res) => {
  try {
    const query = `SELECT COUNT(*) AS total_borrowed FROM borrowed_books WHERE book_status = 'UNRETURNED'`;

    // Use callback to log results and handle errors
    db.get(query, (err, row) => {
      if (err) {
        console.error('Database Error:', err.message);
        return res.status(500).json({ error: 'Database query failed' });
      }

      // Return the response
      res.json({ totalBorrowedBooks: row?.total_borrowed || 0 });
    });
  } catch (error) {
    console.error('Server Error:', error);
    res.status(500).json({ error: 'An error occurred while fetching total borrowed books.' });
  }
});




// API to fetch categories
app.get("/categories", (req, res) => {
  const query = "SELECT * FROM categories";
  db.all(query, [], (err, rows) => {
    if (err) {
      console.error("Error fetching categories:", err.message);
      res.status(500).json({ error: "Failed to fetch categories" });
    } else {
      res.json(rows);
    }
  });
});

// Add new book with image
app.post("/books", upload.single("cover_image"), (req, res) => {
  const { title, isbn, author, total_copies, available_copies, description, categories } = req.body;
  const coverImage = req.file ? req.file.buffer : null;

  // Parse categories from JSON string (if necessary)
  let categoryIds = [];
  if (categories) {
    try {
      categoryIds = JSON.parse(categories);  // Parse the category IDs string to array
    } catch (err) {
      console.error("Error parsing categories:", err);
      return res.status(400).json({ error: "Invalid category data" });
    }
  }

  // SQL query to insert book into available_books table with description
  const sql = `
    INSERT INTO available_books (title, isbn, author, total_copies, available_copies, description, cover_image)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  // Insert the book into the database
  db.run(
    sql,
    [title, isbn, author, total_copies, available_copies, description, coverImage],
    function (err) {
      if (err) {
        console.error(err.message);
        return res.status(500).json({ error: "Failed to add book" });
      }

      // Get the book ID of the newly inserted book
      const bookId = this.lastID;

      // Ensure categories are an array and insert into book_categories
      if (categoryIds.length > 0) {
        const insertCategorySql = `
          INSERT INTO book_categories (book_id, category_id)
          VALUES (?, ?)
        `;

        // Insert categories associated with the book
        categoryIds.forEach((categoryId) => {
          db.run(insertCategorySql, [bookId, categoryId], (err) => {
            if (err) {
              console.error("Error inserting category:", err.message);
              return res.status(500).json({ error: "Failed to associate categories with the book" });
            }
          });
        });
      }

      // Send response once everything is done
      res.status(201).json({ message: "Book added successfully", book_id: bookId });
    }
  );
});


// Get Book Details
app.get("/book/:bookId", (req, res) => {
  const { bookId } = req.params;

  const query = `
    SELECT b.*, 
           c.name AS category_name
    FROM available_books AS b
    LEFT JOIN book_categories AS bc ON b.book_id = bc.book_id
    LEFT JOIN categories AS c ON bc.category_id = c.category_id
    WHERE b.book_id = ?
  `;

  db.all(query, [bookId], (err, rows) => {
    if (err) {
      console.error("Error fetching book:", err);
      return res.status(500).json({ error: "An error occurred while fetching the book data." });
    }

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "Book not found." });
    }

    // Initialize the book data from the first row
    const book = { ...rows[0] };

    // Extract the categories from the result rows
    const categories = rows.map(row => row.category_name).filter(name => name);

    // Convert the BLOB image to Base64 if the cover_image field is not null
    if (book.cover_image) {
      const base64Image = Buffer.from(book.cover_image).toString('base64');
      book.cover_image = `data:image/jpeg;base64,${base64Image}`; // Adjust the MIME type as needed (e.g., image/png)
    }

    // Attach the categories to the book data
    book.categories = categories;

    // Send the response with the book data and categories
    res.json(book);
  });
});




// Edit Book
app.put('/book-edit/:bookId', upload.single('cover_image'), async (req, res) => {
  const { bookId } = req.params;
  const { title, isbn, author, total_copies, available_copies, description } = req.body;

  // Check if the uploaded file exceeds the size limit
  if (req.file && req.file.size > 1 * 2048 * 2048) {
    return res.status(413).json({ error: 'File size exceeds limit of 1MB' });
  }

  try {
    // First, fetch the current book data to retain the image if not updated
    const currentBook = await new Promise((resolve, reject) => {
      db.get("SELECT * FROM available_books WHERE book_id = ?", [bookId], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    // Determine coverImageData based on whether a new image was uploaded
    let coverImageData = req.file ? req.file.buffer : currentBook.cover_image; // Use existing image if no new image

    // Update book data in the database, including the description
    const result = await db.run(
      `UPDATE available_books SET title = ?, isbn = ?, author = ?, total_copies = ?, available_copies = ?, cover_image = ?, description = ? WHERE book_id = ?`,
      [title, isbn, author, total_copies, available_copies, coverImageData, description, bookId]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Book not found or data unchanged' });
    }
    
    res.json({ message: 'Book updated successfully' });
  } catch (error) {
    console.error("Error updating book:", error);
    res.status(500).json({ error: 'An error occurred while updating the book' });
  }
});


// Endpoint to get borrowers for a specific book
app.get('/book-requests/:bookId', (req, res) => {
  const { bookId } = req.params;

  // Wrapping db.all in a Promise to enable .then() and .catch()
  new Promise((resolve, reject) => {
    db.all(`
      SELECT 
        br.req_id,
        br.borrower_id,
        b.first_name,
        b.last_name,
        b.email,
        b.contact_number,
        b.borrower_type,
        br.status,
        br.req_created,
        br.req_approve,
        br.overdue_days
      FROM book_req br
      JOIN borrowers b ON br.borrower_id = b.borrower_id
      JOIN borrowed_books bb ON br.req_id = bb.req_id
      WHERE bb.book_id = ? 
      AND br.status NOT IN ('Pending', 'Rejected') 
    `, [bookId], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  })
  .then((result) => {
    // Log the result to check if it's correct
    console.log('Fetched book requests:', result);

    if (result.length === 0) {
      return res.status(404).json({ message: 'No requests found for this book' });
    }
    res.json(result);
  })
  .catch((error) => {
    console.error('Error fetching book requests:', error);
    res.status(500).json({ error: 'An error occurred while fetching book requests' });
  });
});




// Cron job for calculating penalty
cron.schedule('0 * * * *', () => {
  console.log('Running hourly job to update hours_due and penalties...');

  const now = new Date();
  const nowInMillis = now.getTime();

  // Query to select all overdue books that have not paid the penalty
  const query = `
    SELECT borrow_id, due_date 
    FROM borrowed_books 
    WHERE due_date < CURRENT_DATE;  
  `;

  db.all(query, (err, rows) => {
    if (err) {
      console.error('Error fetching overdue books:', err);
      return;
    }

    // Process each overdue book
    rows.forEach(row => {
      const dueDate = new Date(row.due_date);
      const hoursDue = Math.floor((nowInMillis - dueDate.getTime()) / (1000 * 60 * 60)); // Calculate hours overdue
      const penalty = hoursDue * 5; // Calculate penalty at 5 PHP per hour

      // Update hours_due and penalty for each book
      const updateQuery = `
        UPDATE borrowed_books
        SET hours_due = ?, penalty = ?
        WHERE borrow_id = ?;
      `;

      db.run(updateQuery, [hoursDue, penalty, row.borrow_id], err => {
        if (err) {
          console.error(`Error updating borrow_id ${row.borrow_id}:`, err);
        } else {
          console.log(`Updated borrow_id ${row.borrow_id} with ${hoursDue} hours and ${penalty} PHP penalty.`);
        }
      });
    });
  });
});

// Cron for updating book status
const updateOverdueStatuses = () => {
  const updateQuery = `
  UPDATE borrowed_books
  SET book_status = 'OVERDUE'
  WHERE due_date < DATE('now')
  AND book_status != 'OVERDUE';

  `;
  
  
  db.run(updateQuery, function (err) {
    if (err) {
      console.error('Error updating overdue requests:', err.message);
    } else {
      console.log(`Overdue statuses updated successfully. Changes made: ${this.changes}`);
    }
  });
  };
cron.schedule('0 * * * *', updateOverdueStatuses);

//Cron for updating request status
cron.schedule('0 * * * *', () => {
  console.log('Running overdue check...');

  // Query to find requests with associated overdue books
  const query = `
    SELECT br.req_id
    FROM book_req br
    JOIN borrowed_books bb ON br.req_id = bb.req_id
    WHERE bb.book_status = 'OVERDUE'
    GROUP BY br.req_id;
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Error checking for overdue requests:', err);
      return;
    }

    if (rows.length === 0) {
      console.log('No overdue requests found.');
      return;
    }

    // Update the status of each overdue request
    rows.forEach(row => {
      db.run(
        `UPDATE book_req SET status = 'Overdue' WHERE req_id = ?`,
        [row.req_id],
        (updateErr) => {
          if (updateErr) {
            console.error(`Error updating request ${row.req_id}:`, updateErr);
          } else {
            console.log(`Request ${row.req_id} status updated to Overdue.`);
          }
        }
      );
    });
  });
});


// POST endpoint to update book status
app.post('/update-book-status/:bookId', async (req, res) => {
  const { bookId } = req.params;
  const { book_status } = req.body;

  if (!book_status) {
    return res.status(400).json({ error: 'Book status is required' });
  }

  try {
    const result = await db.run(
      `UPDATE borrowed_books SET book_status = ? WHERE book_id = ?`,
      [book_status, bookId]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Book not found or status unchanged' });
    }

    // If the book status is 'RETURNED', increase the available_copies
    if (book_status === 'RETURNED') {
      await db.run(
        `UPDATE available_books SET available_copies = available_copies + 1 WHERE book_id = ?`,
        [bookId]
      );
    }

    res.json({ message: 'Book status updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'An error occurred while updating book status' });
  }
});

// Fetch request details by requestId
app.get('/req/:id', (req, res) => {
  const requestId = req.params.id;

  const sql = `
    SELECT 
      br.req_id,
      br.borrower_id,
      br.status,
      br.req_created,
      br.req_approve,
      b.first_name,
      b.last_name,
      b.borrower_type,
      bb.borrow_id,
      bb.book_id,
      ab.title,
      ab.isbn,
      bb.due_date,
      bb.book_status,
      bb.hours_due,
      bb.penalty
    FROM 
      book_req AS br
    JOIN 
      borrowers AS b ON br.borrower_id = b.borrower_id
    LEFT JOIN 
      borrowed_books AS bb ON br.req_id = bb.req_id
    LEFT JOIN 
      available_books AS ab ON bb.book_id = ab.book_id
    WHERE 
      br.req_id = ?;  -- Filter by request ID
  `;

  db.all(sql, [requestId], (err, rows) => {
    if (err) {
      console.error('Error fetching request:', err.message);
      return res.status(500).json({ message: 'Error fetching request.' });
    }

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Request not found.' });
    }

    // Format the result
    const requestDetails = {
      req_id: rows[0].req_id,
      borrower_id: rows[0].borrower_id,
      status: rows[0].status,
      req_created: rows[0].req_created,
      req_approve: rows[0].req_approve,
      borrower: {
        first_name: rows[0].first_name,
        last_name: rows[0].last_name,
        borrower_type: rows[0].borrower_type,
      },
      books: rows.map(row => ({
        borrow_id: row.borrow_id,
        book_id: row.book_id,
        title: row.title,
        isbn: row.isbn,
        due_date: row.due_date,
        book_status: row.book_status,
        hours_due: row.hours_due,
        penalty: row.penalty,
      })),
    };

    res.status(200).json(requestDetails);
  });
});

//Get a specific borrower's requests
app.get('/api/borrowers/:borrowerId/requests', async (req, res) => {
  const { borrowerId } = req.params;

  try {
    // Query to fetch the borrower's requests
    const query = `
      SELECT br.req_id, br.status, br.req_created, br.req_approve, br.overdue_days
      FROM book_req br
      WHERE br.borrower_id = ?
    `;
    
    // Execute the query with the borrowerId
    db.all(query, [borrowerId], (err, rows) => {
      if (err) {
        console.error('Error executing query:', err);
        return res.status(500).json({ error: 'An error occurred while fetching borrower requests.' });
      }

      if (rows.length === 0) {
        return res.status(404).json({ message: 'No requests found for this borrower.' });
      }

      // Return the requests data
      res.status(200).json(rows);
    });
  } catch (error) {
    console.error('Error fetching borrower requests:', error);
    res.status(500).json({ error: 'An error occurred while fetching borrower requests.' });
  }
});
// Start the server
app.listen(port, () => {
    console.log('Server is running on http://localhost:5000');
});
