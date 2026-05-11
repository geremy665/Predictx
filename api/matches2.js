module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json({ 
    matches: [], 
    count: 0,
    test: "OK",
    updated: new Date().toISOString()
  });
};
