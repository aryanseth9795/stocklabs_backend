const TryCatch = async (fn: Function) => {
  try {
    await fn();
  } catch (error) {
    console.log(error);
  }
};


export default TryCatch;    
